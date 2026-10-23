#!/usr/bin/env node
/**
 * Smoke test — boots a real gateway against a real (fake) child over the HTTP
 * transport and exercises the paths that actually break in production:
 * proxying, the two failure shapes, call metrics, and the park/remount cycle.
 *
 * Exits non-zero on the first failed assertion. Run with `npm test`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
// A port unlikely to collide with a gateway the developer is already running.
const PORT = 23400 + Math.floor(Math.random() * 500);

let failures = 0;
const ok = (cond, label, detail) => {
  if (cond) { console.log(`  ✓ ${label}`); return; }
  failures++;
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
};
const text = (r) => r?.content?.[0]?.text ?? "";
const json = (r) => { try { return JSON.parse(text(r)); } catch { return null; } };
const childNamed = (list, n) => (json(list)?.children || []).find((c) => c.name === n);

// ---- fixture: a config holding one parked-by-default-off child ----
const dir = mkdtempSync(join(tmpdir(), "gw-smoke-"));
const configPath = join(dir, "gateway-config.json");
writeFileSync(configPath, JSON.stringify({
  children: [{
    name: "fake",
    transport: "stdio",
    command: process.execPath,
    args: [join(__dirname, "fake-child.mjs")],
  }],
}, null, 2));

const stderrPath = join(dir, "stderr.log");
let stderrBuf = "";
const gateway = spawn(process.execPath, [join(ROOT, "index.mjs")], {
  env: { ...process.env, MCP_GATEWAY_CONFIG: configPath, GATEWAY_HTTP_PORT: String(PORT) },
  stdio: ["ignore", "ignore", "pipe"],
});
gateway.stderr.on("data", (d) => { stderrBuf += d.toString(); });

const cleanup = () => { try { gateway.kill(); } catch { /* already gone */ } };
process.on("exit", cleanup);

// ---- wait for the daemon to accept connections ----
const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
let connected = false;
for (let i = 0; i < 50 && !connected; i++) {
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
    connected = true;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
if (!connected) {
  console.error("gateway did not come up on port", PORT, "\n", stderrBuf);
  process.exit(1);
}

console.log("\nmount + proxy");
{
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  ok(names.includes("gateway_list") && names.includes("gateway_mount") && names.includes("gateway_unmount"),
     "three meta tools are always present");
  ok(names.includes("fake__echo"), "child tool is namespaced <child>__<tool>", names.join(","));
  const echo = tools.find((t) => t.name === "fake__echo");
  ok(echo?.description?.startsWith("[fake]"), "description carries the child prefix", echo?.description);

  const r = await client.callTool({ name: "fake__echo", arguments: { text: "hello" } });
  ok(text(r) === "hello", "call is proxied to the child and the result comes back", text(r));
}

console.log("\nfailure shapes");
{
  const soft = await client.callTool({ name: "fake__soft_fail", arguments: {} });
  ok(soft?.isError === true, "tool-level failure surfaces as isError");
  const hard = await client.callTool({ name: "fake__hard_fail", arguments: {} });
  ok(hard?.isError === true, "thrown child error surfaces as isError");
  const unknown = await client.callTool({ name: "fake__nope", arguments: {} });
  ok(unknown?.isError === true && text(unknown).includes("Unknown tool"), "unknown tool is rejected", text(unknown));
}

console.log("\ncall metrics");
{
  const list = await client.callTool({ name: "gateway_list", arguments: {} });
  const s = childNamed(list, "fake")?.stats;
  ok(!!s, "gateway_list reports stats for the child");
  ok(s?.calls === 3, "counts every proxied call (3 tool calls, unknown excluded)", `calls=${s?.calls}`);
  ok(s?.errors === 2, "counts both failure shapes as errors", `errors=${s?.errors}`);
  ok(typeof s?.lastMs === "number" && s.lastMs >= 0, "records call duration", `lastMs=${s?.lastMs}`);
  ok(s?.lastTool === "hard_fail", "records the last tool called", `lastTool=${s?.lastTool}`);
  ok(!!s?.lastAt, "records when the last call happened");
  ok(s?.inFlight === 0, "no call in flight once every call returned", `inFlight=${s?.inFlight}`);
  ok(Number.isInteger(childNamed(list, "fake")?.pid), "gateway_list reports the stdio child's pid");

  ok(/fake\.echo ok \d+ms/.test(stderrBuf), "logs one trace line per call, with the tool name",
     stderrBuf.split("\n").filter((l) => l.includes("fake.")).join(" | "));
  ok(!stderrBuf.includes("hello"), "never logs call arguments");
}

console.log("\npark + remount cycle");
{
  const un = await client.callTool({ name: "gateway_unmount", arguments: { name: "fake" } });
  ok(json(un)?.parked === true, "unmount parks the child by default", text(un));
  const afterUnmount = await client.listTools();
  ok(!afterUnmount.tools.some((t) => t.name.startsWith("fake__")), "parked child's tools disappear");
  const stillListed = childNamed(await client.callTool({ name: "gateway_list", arguments: {} }), "fake");
  ok(stillListed && stillListed.mounted === false, "parked child stays visible in gateway_list");

  const re = await client.callTool({ name: "gateway_mount", arguments: { name: "fake" } });
  ok(json(re)?.tools?.includes("fake__echo"), "bare {name} remounts a parked child from stored config", text(re));
  const afterRemount = await client.listTools();
  ok(afterRemount.tools.some((t) => t.name === "fake__echo"), "child tools come back");

  const s = childNamed(await client.callTool({ name: "gateway_list", arguments: {} }), "fake")?.stats;
  ok(s?.calls === 3, "metrics survive the park/remount cycle", `calls=${s?.calls}`);
}

console.log("\npersistence");
{
  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  const fake = saved.children.find((c) => c.name === "fake");
  ok(!!fake, "child is persisted to the config file");
  ok(fake?.command === process.execPath, "connection details round-trip intact");
}

await client.close();
gateway.kill();
writeFileSync(stderrPath, stderrBuf);

console.log(failures === 0 ? "\nall green\n" : `\n${failures} failing assertion(s) — gateway stderr at ${stderrPath}\n`);
process.exit(failures === 0 ? 0 : 1);
