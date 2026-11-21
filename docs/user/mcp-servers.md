# MCP servers

T3 Code can run local [MCP](https://modelcontextprotocol.io) servers of your own and give their tools to agents. While a registered server is enabled, T3 Code runs it on the machine running the server and stops it when T3 Code stops.

Only servers T3 Code launches itself are supported: a local stdio package from the MCP Registry's `server.json`, or an MCPB manifest. Remote servers are rejected when you register them.

## Register a server

Paste the whole `server.json` (or an MCPB `manifest.json`) into **Settings → Capabilities → General**. For an MCPB bundle, also give the directory its files live in, so `${__dirname}` resolves.

Each server then gets its own entry under **Capabilities**, where you can:

- turn it on or off
- change its **Tool name**, the prefix agents see. A server's `search` tool becomes `notes_search` under the tool name `notes`.
- fill in the settings its document declares. Secret fields are kept in the server's secret store.

A server that fails to start or exits stays off until you change its settings or turn it off and on again. The reason is in T3 Code's server log.

## What agents see

Agents call a server's tools directly, like T3 Code's own tools, and `external_connectors` lists each registered server with its tools. Only enable a server whose code you trust; its tools run with the same permissions as T3 Code.
