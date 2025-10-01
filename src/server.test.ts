import { describe, it, expect } from "bun:test";
import { ObsidianServer } from "./server.js";
import { z } from "zod";
import os from "os";
import path from "path";
import fs from "fs";

const createTempVault = async () => {
  const prefix = path.join(os.tmpdir(), "obsidian-mcp-test-");
  const dir = await fs.promises.mkdtemp(prefix);
  const vaultPath = path.join(dir, "vault");
  await fs.promises.mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
  return { dir, vaultPath };
};

describe("HTTP compatibility endpoints", () => {
  it("serves list_actions alongside MCP requests", async () => {
    const { dir, vaultPath } = await createTempVault();
    const server = new ObsidianServer([{ name: "test", path: vaultPath }]);

    server.registerTool({
      name: "echo",
      description: "Echo back provided text",
      inputSchema: z.object({
        message: z.string()
      }),
      handler: async (args: { message: string }) => ({
        content: [
          {
            type: "text",
            text: args.message
          }
        ]
      })
    });

    await server.start({
      type: "http",
      host: "127.0.0.1",
      port: 0,
      path: "/mcp"
    });

    const httpServer = (server as unknown as { httpServer?: import("http").Server }).httpServer;
    if (!httpServer) {
      throw new Error("HTTP server was not started");
    }

    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to determine listening address");
    }

    const baseUrl = `http://127.0.0.1:${address.port}/mcp`;

    try {
      const listActionsResponse = await fetch(`${baseUrl}/list_actions`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: "{}"
      });
      expect(listActionsResponse.status).toBe(200);
      const listActionsJson = await listActionsResponse.json();
      expect(Array.isArray(listActionsJson.actions)).toBe(true);
      expect(listActionsJson.actions.some((action: any) => action.id === "echo")).toBe(true);
      const echoAction = listActionsJson.actions.find((action: any) => action.id === "echo");
      expect(echoAction).toBeTruthy();

      const initializeResponse = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "mcp-protocol-version": "2024-11-05"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "init",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: {
              name: "test-client",
              version: "1.0.0"
            }
          }
        })
      });
      expect(initializeResponse.status).toBe(200);
      const sessionId = initializeResponse.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      if (initializeResponse.body) {
        await initializeResponse.body.cancel();
      }

      const toolHeaders: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
        "mcp-protocol-version": "2024-11-05"
      };
      if (sessionId) {
        toolHeaders["mcp-session-id"] = sessionId;
      }

      const mcpResponse = await fetch(baseUrl, {
        method: "POST",
        headers: toolHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          method: "tools/list",
          params: {}
        })
      });
      const mcpText = await mcpResponse.text();
      expect(mcpResponse.status).toBe(200);
      const dataLine = mcpText
        .split(/\r?\n/)
        .map((line: string) => line.trim())
        .find((line: string) => line.startsWith("data:"));
      expect(dataLine).toBeTruthy();
      const mcpJson = JSON.parse((dataLine as string).slice(5).trim());
      expect(Array.isArray(mcpJson.result?.tools)).toBe(true);
      expect(mcpJson.result.tools.some((tool: any) => tool.name === "echo")).toBe(true);
      const echoTool = mcpJson.result.tools.find((tool: any) => tool.name === "echo");
      expect(echoTool).toBeTruthy();
      expect(echoAction.parameters).toEqual(echoTool.inputSchema);
    } finally {
      await server.stop();
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("handles repeated base path segments for reverse proxy deployments", async () => {
    const { dir, vaultPath } = await createTempVault();
    const server = new ObsidianServer([{ name: "test", path: vaultPath }]);

    server.registerTool({
      name: "echo",
      description: "Echo back provided text",
      inputSchema: z.object({
        message: z.string()
      }),
      handler: async (args: { message: string }) => ({
        content: [
          {
            type: "text",
            text: args.message
          }
        ]
      })
    });

    await server.start({
      type: "http",
      host: "127.0.0.1",
      port: 0,
      path: "/mcp"
    });

    const httpServer = (server as unknown as { httpServer?: import("http").Server }).httpServer;
    if (!httpServer) {
      throw new Error("HTTP server was not started");
    }

    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to determine listening address");
    }

    const doubleBaseUrl = `http://127.0.0.1:${address.port}/mcp/mcp`;

    try {
      const listActionsResponse = await fetch(`${doubleBaseUrl}/list_actions`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: "{}"
      });
      expect(listActionsResponse.status).toBe(200);
      const listActionsJson = await listActionsResponse.json();
      expect(Array.isArray(listActionsJson.actions)).toBe(true);
      expect(listActionsJson.actions.some((action: any) => action.id === "echo")).toBe(true);

      const initializeResponse = await fetch(doubleBaseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "mcp-protocol-version": "2024-11-05"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "init",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: {
              name: "test-client",
              version: "1.0.0"
            }
          }
        })
      });
      expect(initializeResponse.status).toBe(200);
      const sessionId = initializeResponse.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      if (initializeResponse.body) {
        await initializeResponse.body.cancel();
      }

      const toolHeaders: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
        "mcp-protocol-version": "2024-11-05"
      };
      if (sessionId) {
        toolHeaders["mcp-session-id"] = sessionId;
      }

      const mcpResponse = await fetch(doubleBaseUrl, {
        method: "POST",
        headers: toolHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          method: "tools/list",
          params: {}
        })
      });
      const mcpText = await mcpResponse.text();
      expect(mcpResponse.status).toBe(200);
      const dataLine = mcpText
        .split(/\r?\n/)
        .map((line: string) => line.trim())
        .find((line: string) => line.startsWith("data:"));
      expect(dataLine).toBeTruthy();
      const mcpJson = JSON.parse((dataLine as string).slice(5).trim());
      expect(Array.isArray(mcpJson.result?.tools)).toBe(true);
      expect(mcpJson.result.tools.some((tool: any) => tool.name === "echo")).toBe(true);
    } finally {
      await server.stop();
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});
