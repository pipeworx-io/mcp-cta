# mcp-cta

CTA MCP — Chicago Transit Authority real-time trains ('L') + buses

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Cta data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
