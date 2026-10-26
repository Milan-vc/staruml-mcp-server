#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as response from "./response.js";
import { JsonRpcErrorCode } from "./response.js";
import { api } from "./utils.js";
import packageJson from "../package.json" with { type: "json" };

const NAME = "staruml-mcp-server";
const VERSION = packageJson.version;

const lineStyleSchema = z.enum([
  "direct",
  "rectilinear",
  "oblique",
  "roundrect",
  "curve",
]);

const layoutDirectionSchema = z.enum([
  "left-to-right",
  "right-to-left",
  "top-to-bottom",
  "bottom-to-top",
]);

const relationshipStyleSchema = z.object({
  name: z.string().min(1).optional().describe("Relationship name to match."),
  source: z.string().min(1).optional().describe("Source class name to match."),
  target: z.string().min(1).optional().describe("Target class name to match."),
  lineStyle: lineStyleSchema.optional(),
  lineColor: z.string().min(1).optional().describe("CSS line color, such as #2563eb."),
}).refine(
  (style) => Boolean(style.name || (style.source && style.target)),
  { message: "Provide name, or both source and target, to select a relationship." }
);

type DiagramImage =
  | string
  | {
      data: string;
      mimeType: "image/png" | "image/jpeg";
    };

// port number for the StarUML's API server (default: 58321)
let apiPort: number = 58321;

// command line argument parsing
const args = process.argv.slice(2);
const apiPortArg = args.find((arg) => arg.startsWith("--api-port="));
if (apiPortArg) {
  const port = apiPortArg.split("=")[1];
  try {
    apiPort = parseInt(port, 10);
    if (isNaN(apiPort) || apiPort < 0 || apiPort > 65535) {
      throw new Error(`Invalid port number: ${port}`);
    }
  } catch (error) {
    console.error(`Invalid port number: ${port}`);
    process.exit(1);
  }
}

// Create an MCP server
const server = new McpServer({
  name: NAME,
  version: VERSION,
});

server.tool(
  "move_view",
  "Moves a view to a set of coordinates.",
  {
    id: z
      .string()
      .describe("The id of the view."),
    x: z
      .number()
      .finite()
      .min(-100000)
      .max(100000)
      .describe("Absolute horizontal position in diagram pixels."),

    y: z
      .number()
      .finite()
      .min(-100000)
      .max(100000)
      .describe("Absolute vertical position in diagram pixels."),
  },
  async({
    id,x,y
  }) => {
     try {
      const result = await api(apiPort, "/move_view", {
        id,x,y
      });
      return response.text(
        `View moved: ${JSON.stringify(result)}`
      );
    } catch (error) {
      console.error(error);
      return response.error(
        JsonRpcErrorCode.InternalError,
        `Failed to move view ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
)

server.tool(
  "generate_diagram",
  "Create a new diagram or replace an existing generated diagram.",
  {
    code: z
      .string()
      .describe("Mermaid code used to generate the diagram."),

    diagramId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Existing diagram ID to replace. Omit this to create a new diagram."
      ),

    replace: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Must be true when diagramId is provided, to confirm replacement."
      ),

    lineStyle: lineStyleSchema
      .optional()
      .default("direct")
      .describe(
        "Default connector routing. 'direct' is one straight segment; 'rectilinear' uses square 90-degree bends."
      ),

    lineColor: z
      .string()
      .min(1)
      .optional()
      .describe("Default CSS connector color, such as #334155."),

    layoutDirection: layoutDirectionSchema
      .optional()
      .default("left-to-right")
      .describe("Direction used by automatic diagram layout."),

    nodeSpacing: z.number().int().min(10).max(500).optional().default(30),
    edgeSpacing: z.number().int().min(5).max(500).optional().default(20),
    rankSpacing: z.number().int().min(20).max(1000).optional().default(120),

    relationshipStyles: z
      .array(relationshipStyleSchema)
      .max(100)
      .optional()
      .describe(
        "Per-relationship overrides, selected by relationship name or by source and target class names."
      ),
  },
  async ({
    code,
    diagramId,
    replace,
    lineStyle,
    lineColor,
    layoutDirection,
    nodeSpacing,
    edgeSpacing,
    rankSpacing,
    relationshipStyles,
  }) => {
    try {
      const result = await api(apiPort, "/generate_diagram", {
        code,
        diagramId,
        replace,
        lineStyle,
        lineColor,
        layoutDirection,
        nodeSpacing,
        edgeSpacing,
        rankSpacing,
        relationshipStyles,
      });

      return response.text(
        `Diagram generated: ${JSON.stringify(result)}`
      );
    } catch (error) {
      console.error(error);
      return response.error(
        JsonRpcErrorCode.InternalError,
        `Failed to generate diagram: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
);

server.tool(
  "get_all_diagrams_info",
  "Get information for all diagrams in StarUML.",
  {},
  async ({}) => {
    try {
      const data = await api(apiPort, "/get_all_diagrams_info", {});
      return response.text(`All diagrams: ${JSON.stringify(data)}`);
    } catch (error) {
      console.error(error);
      return response.error(
        JsonRpcErrorCode.InternalError,
        `Failed to get all diagrams info: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
);

server.tool(
  "get_current_diagram_info",
  "Get information for the current diagram in StarUML.",
  {},
  async ({}) => {
    try {
      const data = await api(apiPort, "/get_current_diagram_info", {});
      if (data) {
        return response.text(`Current diagram: ${JSON.stringify(data)}`);
      } else {
        return response.text("No current diagram found.");
      }
    } catch (error) {
      console.error(error);
      return response.error(
        JsonRpcErrorCode.InternalError,
        `Failed to get current diagram info: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
);

server.tool(
  "get_diagram_image_by_id",
  "Get the image of a diagram by its ID in StarUML.",
  {
    diagramId: z
      .string()
      .describe(
        "ID of the diagram to get the image for. You can get the ID from the 'get_all_diagrams_info' tool."
      ),
  },
  async ({ diagramId }) => {
    try {
      const image = (await api(apiPort, "/get_diagram_image_by_id", {
        diagramId,
      })) as DiagramImage;

      // The original StarUML API returns a bare PNG string. The StarUML 4
      // compatibility bridge returns the data together with its MIME type.
      if (typeof image === "string") {
        return response.image("image/png", image);
      }
      if (!image || typeof image.data !== "string") {
        throw new Error("StarUML returned an invalid diagram image payload");
      }
      if (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg") {
        throw new Error(`StarUML returned an unsupported image type: ${image.mimeType}`);
      }

      return response.image(image.mimeType, image.data);
    } catch (error) {
      console.error(error);
      return response.error(
        JsonRpcErrorCode.InternalError,
        `Failed to get diagram image by id: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("StarUML MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Error starting server:", error);
  process.exit(1);
});
