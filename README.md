# mcp-cta

CTA MCP — Chicago Transit Authority real-time trains ('L') + buses

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1331+ live data sources.

## Tools

| Tool | Description |
|------|-------------|

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

Or connect to the full Pipeworx gateway for access to all 1331+ data sources:

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

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
