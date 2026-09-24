# mcp-cta

CTA MCP — Chicago Transit Authority real-time trains ('L') + buses

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `cta_train_arrivals` | Real-time Chicago CTA 'L' train arrivals at a station — answers "when is the next train Chicago", next Red Line at Belmont, Blue Line to O'Hare from Clark/Lake. Returns each upcoming train's line color, destination, arrival time and minutes_away, plus approaching / delayed / scheduled-only flags and the platform description. Station accepts a name ("Belmont", "Clark/Lake", "O'Hare") or a 5-digit mapid (e.g. 41320). Example: cta_train_arrivals({ station: "Belmont", route: "Red" }) |
| `cta_train_positions` | Live Chicago CTA 'L' train positions on one or more lines — where every Red Line, Blue Line, Brown, Green, Orange, Purple, Pink, or Yellow train is right now: lat/lon, heading, next station with ETA, destination, approaching and delayed flags. Answers "where are the Blue Line trains" for the Chicago L. Example: cta_train_positions({ routes: "Red,Blue" }) |
| `cta_bus_predictions` | Chicago CTA bus tracker arrival predictions at a bus stop — route, destination, predicted minutes until arrival ("DUE" = arriving now), delay flag, and vehicle id. Pass stop_id (the 4-5 digit stop number posted on CTA bus-stop signs), optionally with route. If you only know the stop by name, pass route + find_stop (a street/intersection fragment like "clark & madison") and the stop is looked up for you. Example: cta_bus_predictions({ route: "22", find_stop: "addison" }) |
| `cta_bus_positions` | Live Chicago CTA bus positions on a route — every vehicle currently running: lat/lon, heading, destination, delayed flag, and distance along the pattern. Answers "where is the 22 Clark bus right now" via the CTA bus tracker. Example: cta_bus_positions({ route: "22" }) |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "cta": {
      "url": "https://gateway.pipeworx.io/cta/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/cta/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/cta_train_arrivals \
  -H 'Content-Type: application/json' \
  -d '{"station":"Belmont","route":"Red"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/cta_train_arrivals`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "cta": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-cta"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-cta
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Cta data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
