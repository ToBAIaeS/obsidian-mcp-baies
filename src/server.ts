import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode
} from "@modelcontextprotocol/sdk/types.js";
import { RateLimiter, ConnectionMonitor, validateMessageSize } from "./utils/security.js";
import { Tool } from "./types.js";
import { z } from "zod";
import path from "path";
import os from 'os';
import fs from 'fs';
import http from "http";
import { randomUUID } from "crypto";
import type { AddressInfo } from "net";
import {
  listVaultResources,
  readVaultResource
} from "./resources/resources.js";
import { listPrompts, getPrompt, registerPrompt } from "./utils/prompt-factory.js";
import { listVaultsPrompt } from "./prompts/list-vaults/index.js";

// Utility function to expand home directory
function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

export class ObsidianServer {
  private server: Server;
  private tools: Map<string, Tool<any>> = new Map();
  private vaults: Map<string, string> = new Map();
  private rateLimiter: RateLimiter;
  private connectionMonitor: ConnectionMonitor;
  private httpServer?: http.Server;
  private activeTransport?: StdioServerTransport | StreamableHTTPServerTransport;

  constructor(vaultConfigs: { name: string; path: string }[]) {
    if (!vaultConfigs || vaultConfigs.length === 0) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'No vault configurations provided. At least one valid Obsidian vault is required.'
      );
    }

    // Initialize vaults
    vaultConfigs.forEach(config => {
      const expandedPath = expandHome(config.path);
      const resolvedPath = path.resolve(expandedPath);
      
      // Check if .obsidian directory exists
      const obsidianConfigPath = path.join(resolvedPath, '.obsidian');
      try {
        const stats = fs.statSync(obsidianConfigPath);
        if (!stats.isDirectory()) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Invalid Obsidian vault at ${config.path}: .obsidian exists but is not a directory`
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Invalid Obsidian vault at ${config.path}: Missing .obsidian directory. Please open this folder in Obsidian first to initialize it.`
          );
        }
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Error accessing vault at ${config.path}: ${(error as Error).message}`
        );
      }

      this.vaults.set(config.name, resolvedPath);
    });
    this.server = new Server(
      {
        name: "obsidian-mcp",
        version: "1.0.6"
      },
      {
        capabilities: {
          resources: {},
          tools: {},
          prompts: {}
        }
      }
    );

    // Initialize security features
    this.rateLimiter = new RateLimiter();
    this.connectionMonitor = new ConnectionMonitor();

    // Register prompts
    registerPrompt(listVaultsPrompt);

    this.setupHandlers();

    // Setup connection monitoring with grace period for initialization
    this.connectionMonitor.start(() => {
      void this.stop();
    });

    // Update activity during initialization
    this.connectionMonitor.updateActivity();

    // Setup error handler
    this.server.onerror = (error) => {
      console.error("Server error:", error);
    };
  }

  registerTool<T>(tool: Tool<T>) {
    console.error(`Registering tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
    console.error(`Current tools: ${Array.from(this.tools.keys()).join(', ')}`);
  }

  private validateRequest(request: any) {
    try {
      // Validate message size
      validateMessageSize(request);

      // Update connection activity
      this.connectionMonitor.updateActivity();

      // Check rate limit (using method name as client id for basic implementation)
      if (!this.rateLimiter.checkLimit(request.method)) {
        throw new McpError(ErrorCode.InvalidRequest, "Rate limit exceeded");
      }
    } catch (error) {
      console.error("Request validation failed:", error);
      throw error;
    }
  }

  private setupHandlers() {
    // List available prompts
    this.server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
      this.validateRequest(request);
      return listPrompts();
    });

    // Get specific prompt
    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      this.validateRequest(request);
      const { name, arguments: args } = request.params;
      
      if (!name || typeof name !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, "Missing or invalid prompt name");
      }

      const result = await getPrompt(name, this.vaults, args);
      return {
        ...result,
        _meta: {
          promptName: name,
          timestamp: new Date().toISOString()
        }
      };
    });

    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      this.validateRequest(request);
      return {
        tools: Array.from(this.tools.values()).map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema.jsonSchema
        }))
      };
    });

    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      this.validateRequest(request);
      const resources = await listVaultResources(this.vaults);
      return {
        resources,
        resourceTemplates: []
      };
    });

    // Read resource content
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      this.validateRequest(request);
      const uri = request.params?.uri;
      if (!uri || typeof uri !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, "Missing or invalid URI parameter");
      }

      if (!uri.startsWith('obsidian-vault://')) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid URI format. Only vault resources are supported.");
      }

      return {
        contents: [await readVaultResource(this.vaults, uri)]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      this.validateRequest(request);
      const params = request.params;
      if (!params || typeof params !== 'object') {
        throw new McpError(ErrorCode.InvalidParams, "Invalid request parameters");
      }
      
      const name = params.name;
      const args = params.arguments;
      
      if (!name || typeof name !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, "Missing or invalid tool name");
      }

      const tool = this.tools.get(name);
      if (!tool) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }

      try {
        // Validate and transform arguments using tool's schema handler
        const validatedArgs = tool.inputSchema.parse(args);
        
        // Execute tool with validated arguments
        const result = await tool.handler(validatedArgs);
        
        return {
          _meta: {
            toolName: name,
            timestamp: new Date().toISOString(),
            success: true
          },
          content: result.content
        };
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          const formattedErrors = error.errors.map(e => {
            const path = e.path.join(".");
            const message = e.message;
            return `${path ? path + ': ' : ''}${message}`;
          }).join("\n");
          
          throw new McpError(
            ErrorCode.InvalidParams,
            `Invalid arguments:\n${formattedErrors}`
          );
        }
        
        // Enhance error reporting
        if (error instanceof McpError) {
          throw error;
        }
        
        // Convert unknown errors to McpError with helpful message
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async start(config: { type: "stdio" } | {
    type: "http";
    host: string;
    port: number;
    path: string;
    allowedOrigins?: string[];
    allowedHosts?: string[];
    enableDnsRebindingProtection?: boolean;
  } = { type: "stdio" }) {
    if (config.type === "http") {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        allowedOrigins: config.allowedOrigins && config.allowedOrigins.length > 0 ? config.allowedOrigins : undefined,
        allowedHosts: config.allowedHosts && config.allowedHosts.length > 0 ? config.allowedHosts : undefined,
        enableDnsRebindingProtection: config.enableDnsRebindingProtection
      });

      await this.server.connect(transport);

      transport.onerror = (error) => {
        console.error("Transport error:", error);
      };

      const server = http.createServer(async (req, res) => {
        const url = req.url ? new URL(req.url, `http://${req.headers.host ?? "localhost"}`) : null;

        if (!url || url.pathname !== config.path) {
          res.writeHead(404).end("Not Found");
          return;
        }

        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Allow": "GET,POST,DELETE,OPTIONS"
          }).end();
          return;
        }

        try {
          await transport.handleRequest(req as Parameters<typeof transport.handleRequest>[0], res);
        } catch (error) {
          console.error("Failed to handle HTTP request:", error);
          if (!res.headersSent) {
            res.writeHead(500).end("Internal Server Error");
          }
        }
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.on("error", (error) => {
          console.error("HTTP server error:", error);
        });
        server.listen(config.port, config.host, () => {
          resolve();
        });
      });

      const address = server.address();
      if (address && typeof address === "object") {
        const info = address as AddressInfo;
        const resolvedAddress = info.address === "::" ? "[::]" : info.address;
        const displayHost = config.host === "0.0.0.0" || config.host === "::" ? "localhost" : resolvedAddress;
        console.error(`Obsidian MCP Server running on http://${displayHost}:${info.port}${config.path}`);
      } else {
        console.error(`Obsidian MCP Server running on http://${config.host}:${config.port}${config.path}`);
      }

      this.httpServer = server;
      this.activeTransport = transport;
      return;
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Obsidian MCP Server running on stdio");
    this.activeTransport = transport;
  }

  async stop() {
    this.connectionMonitor.stop();
    if (this.activeTransport) {
      try {
        await this.activeTransport.close();
      } catch (error) {
        console.error("Error closing transport:", error);
      }
      this.activeTransport = undefined;
    }

    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer?.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }).catch((error) => {
        console.error("Error closing HTTP server:", error);
      });
      this.httpServer = undefined;
    }

    await this.server.close();
    console.error("Obsidian MCP Server stopped");
  }
}
