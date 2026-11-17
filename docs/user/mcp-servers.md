# MCP servers

T3 Code can run local [MCP](https://modelcontextprotocol.io) servers of your own and give their tools to agents. Register one in **Settings → Capabilities**, and while it is enabled T3 Code starts it on the machine running the server and proxies each of its tools into T3 Code's own MCP server. Agents then call those tools directly, next to T3 Code's built-in ones, and find them the same way.

Only servers T3 Code launches itself are supported: a local stdio package from the MCP Registry's `server.json`, or an MCPB manifest. Remote servers, URLs and other transports are rejected when you register them, because T3 Code has to own the process.

## Register a server

Paste the whole `server.json` (or an MCPB `manifest.json`) into **Settings → Capabilities → Register a server**. T3 Code reads the name and the settings the server asks for, and refuses a document it cannot launch. For an MCPB bundle, also give the directory its files live in, so `${__dirname}` resolves.

Each server gets its own entry under **Capabilities** in Settings, where you can:

- turn it on or off; off means T3 Code stops the process and agents no longer see its tools
- change its **Tool name**, the prefix agents see. Agents call a tool as `<tool name>_<tool>`, so the server's own `echo` becomes `notes_echo`. Names must start with a lowercase letter and use only `a-z`, `0-9`, `_` and `-`, and must not collide with another registered server.
- fill in the settings its document declares. Fields marked secret are stored in the server's secret store and never sent back to a client in plain text.

A server that fails to start shows **Failed** and the end of its error output on that page. T3 Code does not retry it on its own: change a setting, or turn it off and on again, to start it.

## What agents see

Agents find the servers through T3 Code's `external_connectors` tool, which lists each registered server, whether it is running, and the tools it offers. The tools themselves are native T3 Code tools, with the server's own schema, description and annotations.

T3 Code owns the processes: an enabled server runs while T3 Code runs and is stopped when T3 Code stops, when you disable it, or when its settings change. Only enable a server whose code you trust; its tools run with the same permissions as T3 Code.
