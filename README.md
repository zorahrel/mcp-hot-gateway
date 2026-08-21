# mcp-hot-gateway

**An MCP server that mounts other MCP servers at runtime.** The agent calls
`gateway_mount` itself, mid-session — the child's tools appear instantly via
`notifications/tools/list_changed`. No session restart. No config-file edit.

> Most MCP gateways aggregate servers *statically*: you edit a config file or a
> DB, restart, and the tools show up. `mcp-hot-gateway` is **agent-driven and
> runtime-dynamic** — the model (or you) mounts and unmounts child servers
> while the session is live, and the client picks up the new tools immediately.

## The two problems this solves

**1. You need a tool that isn't connected.** Normally you'd stop, edit
`~/.claude.json`, restart the session, and lose your context. With the gateway
connected you just say *"mount the GitHub MCP server"* and its tools are live in
the same turn — namespaced `github__*`.

**2. Your MCP servers are running N times.** A stdio MCP server in your client
config is spawned **once per session**. Five open sessions, five copies of every
server. The gateway runs as a single shared HTTP daemon: every session connects
to the same process, and each child MCP server is spawned exactly **once**,
however many sessions you have open.

## How it works

The gateway runs as a long-lived daemon speaking Streamable HTTP on
`127.0.0.1`. It exposes three always-on meta tools and proxies everything else:

| Tool | What it does |
|------|--------------|
| `gateway_list` | List every configured child — mounted *and* parked — with its tools and call metrics. |
| `gateway_mount` | Connect a child, register its tools, emit `list_changed`. |
| `gateway_unmount` | Disconnect a child, drop its tools, emit `list_changed`. |

Child tools are exposed **namespaced** as `<child>__<tool>` (e.g.
`github__create_issue`), so two children with a tool of the same name never
collide, and the child a call belongs to is legible in the tool name itself.

### Parking

`gateway_unmount` **parks** a child by default: it stays in the config with
`autoMount: false`, so it survives restarts and can be brought back with just
its name — `gateway_mount { "name": "github" }`. Pass `forget: true` to remove
it from the config entirely.

Parking is what makes a large roster affordable. A parked child costs nothing:
no process, and none of its tool descriptions in the model's context. Keep
twenty children configured, mount the two you need today.

### Supported child transports

- **stdio** — `{ transport: "stdio", command, args, env }`
- **streamable http** — `{ transport: "http", url, headers }`
- **sse** — `{ transport: "sse", url, headers }`

## Install

Run it as a daemon and point your client at it over HTTP:

```bash
npm install -g mcp-hot-gateway
GATEWAY_HTTP_PORT=23371 mcp-hot-gateway
```

```jsonc
// ~/.claude.json (or any MCP client config)
{
  "mcpServers": {
    "gateway": {
      "type": "http",
      "url": "http://127.0.0.1:23371/mcp"
    }
  }
}
```

To keep it running, wrap it in whatever your OS uses — a launchd LaunchAgent on
macOS, a systemd user unit on Linux. Copy `gateway-config.example.json` to
`gateway-config.json` to start from a worked example.

> **Upgrading from 1.x:** 1.x was a stdio server spawned per session. 2.x is a
> shared HTTP daemon, so the client entry changes from `"type": "stdio"` with a
> `command` to `"type": "http"` with a `url`. Your `gateway-config.json` carries
> over unchanged.

## Usage

Ask your agent to mount a server, or call the tool directly:

```jsonc
// gateway_mount — register a new stdio child
{
  "name": "github",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
}
```

```jsonc
// gateway_mount — bring a parked child back online
{ "name": "github" }
```

The new tools (`github__*`) are available immediately.

> **Client support note:** the live update relies on the client honoring
> `notifications/tools/list_changed`. Most modern MCP clients (Claude Code,
> etc.) do. The persisted config means even clients that only read the tool
> list at startup will see all previously-mounted children on the next launch.

## Observability

Every proxied call writes one line to stderr, naming the child, the tool, the
outcome and how long it took:

```
[mcp-gateway] github.create_issue ok 412ms
[mcp-gateway] weather.forecast err — fetch failed 3001ms
```

`gateway_list` returns the same information as counters per child:

```jsonc
{
  "name": "github",
  "mounted": true,
  "stats": {
    "calls": 12, "errors": 1,
    "lastTool": "create_issue", "lastMs": 412,
    "lastAt": "2026-08-07T09:31:44.201Z", "lastError": null
  }
}
```

Counters are keyed by child name, so they survive a park/remount cycle and
reset only when the gateway itself restarts. A child that returns
`isError: true` — a tool-level failure, not a transport one — is counted as an
error too, so the error rate doesn't read as zero while every call is failing.

**Call arguments are never logged or retained.** Children receive bearer
tokens, mail bodies and file paths; only the tool name and outcome are
recorded. Set `GATEWAY_LOG_CALLS=0` to silence the per-call lines (the
counters stay).

## Configuration

All optional environment variables:

| Env var | Default | Purpose |
|---------|---------|---------|
| `GATEWAY_HTTP_PORT` | `23371` | Port to listen on, bound to `127.0.0.1`. |
| `GATEWAY_HTTP_TOKEN` | *(off)* | If set, require `Authorization: Bearer <token>`. |
| `GATEWAY_LOG_CALLS` | `1` | Set to `0` to mute the per-call trace lines. |
| `MCP_GATEWAY_CONFIG` | `./gateway-config.json` | Where children are persisted. |
| `MCP_GATEWAY_REGISTRY` | *(off)* | If set to a writable path, also writes a flat `{ server → tools }` snapshot JSON — handy for an external dashboard. |

### Secrets in the config

Any string in `gateway-config.json` may reference an environment variable as
`${VAR}`, expanded when the child is spawned:

```jsonc
{ "headers": { "Authorization": "Bearer ${BEEPER_TOKEN}" } }
```

The placeholder is what gets persisted — resolved secrets are never written
back to disk, so the config file stays safe to commit. `${HOME}` works the same
way, which keeps absolute paths portable across machines.

## Security

The daemon binds to `127.0.0.1` only. That is not sufficient on its own — a web
page you visit can also reach `127.0.0.1` — so two further guards apply:

- **Host pinning** rejects requests whose `Host` header isn't localhost,
  defeating DNS rebinding.
- **Browser-origin rejection** drops any request carrying `Origin`, `Referer`
  or `Sec-Fetch-Site`. Browsers always attach at least one on a cross-origin
  request; legitimate MCP clients attach none. This closes the CSRF path.

`GATEWAY_HTTP_TOKEN` adds a bearer check on top, compared in constant time.

## Tests

```bash
npm test
```

Boots a real gateway against a real child over HTTP and asserts the paths that
actually break: proxying, both failure shapes, the call metrics, the
park/remount cycle, and config persistence. Exits non-zero on the first failure.

## Where this gets used

- **[claude-harness](https://github.com/zorahrel/claude-harness)** — skills,
  commands and tools for Claude Code that survive long autonomous runs. Several
  of them assume the MCP servers this gateway mounts.
- **[jarvis-claudecode](https://github.com/zorahrel/jarvis-claudecode)** — the
  multi-channel router that brings the Claude Code CLI to Telegram, WhatsApp and
  Discord. It runs this gateway as its single MCP entry point, with 18 children
  configured and most of them parked until needed.

## License

MIT © Attilio Cianci
