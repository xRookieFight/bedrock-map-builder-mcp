# bedrock-map-builder-mcp

An MCP server that lets Claude (or any MCP client) build, edit and analyse Minecraft: Bedrock Edition maps in a real
world, not just print commands for you to paste.

> Status: early development. This README only lists what actually works; see the roadmap section for what is planned.

## How it talks to Minecraft

The server drives a Bedrock Dedicated Server (BDS) with a small behavior pack (the bridge) that uses the stable
`@minecraft/server` script API. Commands go in through `scriptevent`, results come back on the server console. Since
the real game reads and writes the world, the files stay in Mojang's format and nothing is guessed.

## Roadmap

- BDS bridge: start/stop, run commands, fill, read regions
- Generators for shapes, terrain and buildings
- Undo journal and resumable build plans
- Offline editing of existing worlds (mcpelauncher, .mcworld)
- WebSocket mode for a world open in the game client
- `.mcstructure` import and export

## License

MIT
