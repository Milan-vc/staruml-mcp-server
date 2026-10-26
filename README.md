[![smithery badge](https://smithery.ai/badge/@staruml/staruml-mcp-server)](https://smithery.ai/server/@staruml/staruml-mcp-server)

# StarUML MCP Server

[StarUML](https://staruml.io) is a sophisticated modeler for agile and concise modeling. **StarUML MCP Server** enables you to create diagrams or generate codes from diagrams in StarUML via prompts.

## Setup

Prerequisite for the upstream StarUML API:

- [StarUML](https://staruml.io/) `v7.0.0` or higher
- [Node.js](https://nodejs.org/) `v22` or higher

### Windows installer (Codex + StarUML 4)

From PowerShell or Command Prompt in this repository, run:

```powershell
.\install.cmd
```

The installer:

- installs the Node.js dependencies and builds the MCP server;
- recursively copies the StarUML 4 bridge (except its development-only
  `types` directory) to
  `%APPDATA%\StarUML\extensions\user\staruml-mcp-bridge-v4`;
- registers the local server in Codex as `staruml`; and
- preserves every unrelated Codex MCP registration.

The installer is safe to rerun. Restart StarUML and Codex after installation.
To use a different StarUML API port or Codex server name, run:

```powershell
.\install.ps1 -ApiPort 58322 -ServerName staruml-local
```

The installer resolves `codex` to an absolute executable path before invoking
it. It checks `-CodexPath`, `CODEX_CLI_PATH`, PowerShell `PATH`, and Codex
Desktop's versioned `%LOCALAPPDATA%\OpenAI\Codex\bin` directory. To select a
specific Codex executable explicitly, use:

```powershell
.\install.ps1 -CodexPath 'C:\full\path\to\codex.exe'
```

### StarUML 4 compatibility

This fork includes `staruml-v4-extension`, a local HTTP bridge for StarUML
4.x. Copy that folder to the StarUML user extensions directory and restart
StarUML:

```text
%APPDATA%\StarUML\extensions\user\staruml-mcp-bridge-v4
```

The bridge starts automatically on `127.0.0.1:58321`. It implements all four
MCP endpoints. Diagram listing, current-diagram inspection, and PNG retrieval
work with existing StarUML 4 diagrams. Diagram generation supports Mermaid
`classDiagram`; the other Mermaid diagram types remain available only with
StarUML 7's built-in API.

The bridge can also be started, stopped, or inspected under
**Tools > StarUML MCP Bridge**.

Set up `claude_desktop_config.json` in Claude Desktop as follows:

```json
{
  "mcpServers": {
    "staruml-mcp-server": {
      "command": "npx",
      "args": ["-y", "staruml-mcp-server"]
    }
  }
}
```

You can use the `--api-port=<port>` option to change the API server port for StarUML.

## Example Prompts

- _"Create a class diagram for book store in StarUML"_
- _"Create a sequence diagram for OAuth authentication in StarUML"_
- _"Generate SQL DDL from the current ERD diagram in StarUML"_

### Connector and layout control

`generate_diagram` creates direct, single-segment connectors by default. It
also accepts:

- `lineStyle`: `direct`, `rectilinear`, `oblique`, `roundrect`, or `curve`;
- `lineColor`: a CSS color applied to connectors;
- `layoutDirection`: `left-to-right`, `right-to-left`, `top-to-bottom`, or
  `bottom-to-top`;
- `nodeSpacing`, `edgeSpacing`, and `rankSpacing`; and
- `relationshipStyles`: per-relationship `lineStyle` and `lineColor`
  overrides selected by relationship `name`, or by `source` and `target`.

Use `direct` for a straight line without bends. Use `rectilinear` for square,
90-degree routing.

## Tools

- `generate_diagram`
- `get_current_diagram_info`
- `get_all_diagrams_info`
- `get_diagram_image_by_id`

## Dev

### StarUML API autocomplete

`staruml-v4-extension/jsconfig.json` loads generated declarations for the
complete public API documented in the
[StarUML 7 API reference](https://files.staruml.io/api-docs/7.0.0/api/index.html).
The declarations cover the global `app` and `type` objects, 49 documented
classes, their constants, properties, methods, and events. JavaScript checking
remains disabled, so IntelliSense works without turning legacy extension code
into implicit-`any` errors.

Regenerate the declarations from the official reference with:

```powershell
npm run types:staruml
```

The compatibility bridge runs in StarUML 4, so APIs introduced after version 4
will autocomplete but may not exist at runtime.

1. Clone this repository.
2. Build with `npm run build`.
3. Update `claude_desktop_config.json` in Claude Desktop as below.
4. Restart Claude Desktop.

```json
{
  "mcpServers": {
    "staruml-mcp-server": {
      "command": "node",
      "args": ["<full-path-to>/staruml-mcp-server/build/index.js"]
    }
  }
}
```
