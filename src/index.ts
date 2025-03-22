import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { config } from "dotenv";
import { WebflowClient } from "webflow-api";
import { z } from "zod";

// Load environment variables from .env file
config();

const accessToken = process.env.WEBFLOW_API_TOKEN || (() => {
  throw new Error("WEBFLOW_API_TOKEN is not defined");
})();

// Initialize the server with explicit methods
const server = new Server(
  {
    name: "webflow-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {
        list: true,
        call: true,
      },
    },
  }
);

const schemas = {
  toolInputs: {
    getSite: z.object({
      siteId: z.string().min(1, "Site ID is required"),
    }),
    getSites: z.object({}),
    testConnection: z.object({
      message: z.string().optional(),
    }),
    getCollections: z.object({
      siteId: z.string().min(1, "Site ID is required"),
    }),
  },
};

interface WebflowApiError {
  status?: number;
  message: string;
  code?: string;
}

type ToolHandler = (args: unknown) => Promise<{
  content: Array<{ type: "text"; text: string }>;
}>;

// Utility functions
function isWebflowApiError(error: unknown): error is WebflowApiError {
  return error !== null && typeof error === "object" && "code" in error;
}

function formatDate(date: Date | undefined | null): string {
  if (!date) return "N/A";
  return date.toLocaleString();
}

// Tool definitions
const TOOL_DEFINITIONS = [
  {
    name: "get_site",
    description:
      "Retrieve detailed information about a specific Webflow site by ID, including workspace, creation date, display name, and publishing details",
    inputSchema: {
      type: "object",
      properties: {
        siteId: {
          type: "string",
          description: "The unique identifier of the Webflow site",
        },
      },
      required: ["siteId"],
    },
  },
  {
    name: "get_sites",
    description:
      "Retrieve a list of all Webflow sites accessible to the authenticated user",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "test_connection",
    description: "A simple test tool to verify MCP connection is working",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "A test message to echo back",
        },
      },
      required: [],
    },
  },
  {
    name: "get_collections",
    description: "Retrieve a list of all CMS collections for a specific Webflow site",
    inputSchema: {
      type: "object",
      properties: {
        siteId: {
          type: "string",
          description: "The unique identifier of the Webflow site",
        },
      },
      required: ["siteId"],
    },
  },
];

// Tool handlers
const toolHandlers: Record<string, ToolHandler> = {
  get_site: async (args: unknown) => {
    const { siteId } = schemas.toolInputs.getSite.parse(args);
    const webflow = new WebflowClient({ accessToken });
    const site = await webflow.sites.get(siteId);

    if (!site) {
      throw new Error("Site not found");
    }

    const formattedSite = `• Site Details:
          ID: ${site.id}
          Display Name: ${site.displayName}
          Short Name: ${site.shortName}
        
        - Workspace Information:
          Workspace ID: ${site.workspaceId}
        
        - Dates:
          Created On: ${formatDate(site?.createdOn)}
          Last Published: ${formatDate(site?.lastPublished)}
        
        - URLs:
          Preview URL: ${site.previewUrl || "N/A"}`;

    return {
      content: [
        {
          type: "text" as const,
          text: formattedSite,
        },
      ],
    };
  },

  get_sites: async () => {
    const webflow = new WebflowClient({ accessToken });
    const { sites } = await webflow.sites.list();

    if (!Array.isArray(sites) || sites.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No sites found for this account.",
          },
        ],
      };
    }

    const formattedSites = sites
      .map(
        (site) => `
• Site: ${site.displayName}
  - ID: ${site.id}
  - Workspace: ${site.workspaceId}
  - Created: ${formatDate(site?.createdOn)}
  - Last Published: ${formatDate(site?.lastPublished)}
  - Preview URL: ${site.previewUrl || "N/A"}
`
      )
      .join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${sites.length} sites:\n${formattedSites}`,
        },
      ],
    };
  },

  test_connection: async (args: unknown) => {
    return {
      content: [
        {
          type: "text" as const,
          text: `Connection test successful! Args received: ${JSON.stringify(args)}`,
        },
      ],
    };
  },

  get_collections: async (args: unknown) => {
    const { siteId } = schemas.toolInputs.getCollections.parse(args);
    const webflow = new WebflowClient({ accessToken });
    const { collections } = await webflow.collections.list(siteId);

    if (!collections || collections.length === 0) {
      return {
        content: [{
          type: "text",
          text: "No collections found for this site."
        }]
      };
    }

    const formattedText = `Found ${collections.length} collections:\n\n` + 
      collections.map(collection => (
        `• Collection: ${collection.displayName}\n` +
        `  - ID: ${collection.id}\n` +
        `  - Slug: ${collection.slug}\n` +
        `  - Created: ${formatDate(collection.createdOn)}\n` +
        `  - Last Updated: ${formatDate(collection.lastUpdated)}`
      )).join('\n\n');

    return {
      content: [{
        type: "text",
        text: formattedText
      }]
    };
  },
};

// Register tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOL_DEFINITIONS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = toolHandlers[name];
  
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  
  return await handler(args);
});

// Start the server
async function main() {
  try {
    if (!process.env.WEBFLOW_API_TOKEN) {
      throw new Error("WEBFLOW_API_TOKEN is not defined");
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    console.error("Startup error:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});