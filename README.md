[![smithery badge](https://smithery.ai/badge/@staruml/staruml-mcp-server)](https://smithery.ai/server/@staruml/staruml-mcp-server)

# StarUML MCP Server

[StarUML](https://staruml.io) is a sophisticated modeler for agile and concise modeling. **StarUML MCP Server** enables you to create diagrams or generate codes from diagrams in StarUML via prompts.

## Setup

Prerequisite for the upstream StarUML API:

- [StarUML](https://staruml.io/) `v7.0.0` or higher
- [Node.js](https://nodejs.org/) `v22` or higher

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

## Tools

- `generate_diagram`
- `get_current_diagram_info`
- `get_all_diagrams_info`
- `get_diagram_image_by_id`

## Dev

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
