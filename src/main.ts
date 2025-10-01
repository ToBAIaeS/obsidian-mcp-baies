#!/usr/bin/env node
import { ObsidianServer } from "./server.js";
import { createCreateNoteTool } from "./tools/create-note/index.js";
import { createListAvailableVaultsTool } from "./tools/list-available-vaults/index.js";
import { createEditNoteTool } from "./tools/edit-note/index.js";
import { createSearchVaultTool } from "./tools/search-vault/index.js";
import { createMoveNoteTool } from "./tools/move-note/index.js";
import { createCreateDirectoryTool } from "./tools/create-directory/index.js";
import { createDeleteNoteTool } from "./tools/delete-note/index.js";
import { createAddTagsTool } from "./tools/add-tags/index.js";
import { createRemoveTagsTool } from "./tools/remove-tags/index.js";
import { createRenameTagTool } from "./tools/rename-tag/index.js";
import { createReadNoteTool } from "./tools/read-note/index.js";
import { listVaultsPrompt } from "./prompts/list-vaults/index.js";
import { registerPrompt } from "./utils/prompt-factory.js";
import path from "path";
import os from "os";
import { promises as fs, constants as fsConstants } from "fs";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { 
  checkPathCharacters, 
  checkLocalPath, 
  checkSuspiciousPath,
  sanitizeVaultName,
  checkPathOverlap 
} from "./utils/path.js";

interface VaultConfig {
  name: string;
  path: string;
}

type TransportMode = "stdio" | "http";

interface CliOptions {
  transport: TransportMode;
  host: string;
  port: number;
  httpPath: string;
  allowedOrigins: string[];
  allowedHosts: string[];
  enableDnsRebindingProtection: boolean;
}

async function main() {
  // Constants
  const MAX_VAULTS = 10; // Reasonable limit to prevent resource issues

  const writeJsonResponse = (payload: unknown) => {
    process.stdout.write(JSON.stringify(payload) + "\n");
  };

  const cliOptions: CliOptions = {
    transport: "stdio",
    host: "0.0.0.0",
    port: 8080,
    httpPath: "/mcp",
    allowedOrigins: [],
    allowedHosts: [],
    enableDnsRebindingProtection: false
  };

  const rawArgs = process.argv.slice(2);
  const vaultArgs: string[] = [];

  const buildHelpMessage = () => `
Obsidian MCP Server - Multi-vault Support

Usage: obsidian-mcp [options] <vault1_path> [vault2_path ...]

Options:
  --help                         Show this help message
  --transport <stdio|http>       Choose transport layer (default: stdio)
  --host <host>                  HTTP host/interface (default: 0.0.0.0)
  --port <port>                  HTTP port (default: ${cliOptions.port})
  --http-path <path>             HTTP endpoint path (default: ${cliOptions.httpPath})
  --allowed-origin <origin>      Allow an Origin header (repeatable, http only)
  --allowed-host <host>          Allow a Host header (repeatable, http only)
  --enable-dns-rebinding-protection  Enforce Host/Origin validation (http only)

Requirements:
- Paths must point to valid Obsidian vaults (containing .obsidian directory)
- Vaults must be initialized in Obsidian at least once
- Paths must have read and write permissions
- Paths cannot overlap (one vault cannot be inside another)
- Each vault must be a separate directory
- Maximum ${MAX_VAULTS} vaults can be connected at once

Security restrictions:
- Must be on a local filesystem (no network drives or mounts)
- Cannot point to system directories
- Hidden directories not allowed (except .obsidian)
- Cannot use the home directory root
- Cannot use symlinks that point outside their directory
- All paths must be dedicated vault directories

Remote deployments:
- Use --transport=http when connecting from ChatGPT Desktop
- Ensure the chosen host/port is reachable from ChatGPT (public internet, VPN, or tunnel)
- Protect the endpoint with network controls (reverse proxy, firewall, or access tunnel)
- Configure --allowed-host/--allowed-origin with --enable-dns-rebinding-protection for public exposure

Note: If a path is not recognized as a vault, open it in Obsidian first to
initialize it properly. This creates the required .obsidian configuration directory.

Recommended locations:
- ~/Documents/Obsidian/[vault-name]     # Recommended for most users
- ~/Notes/[vault-name]                  # Alternative location
- ~/Obsidian/[vault-name]              # Alternative location

Not supported:
- Network drives (//server/share)
- Network mounts (/net, /mnt, /media)
- System directories (/tmp, C:\\Windows)
- Hidden directories (except .obsidian)

Vault names are automatically generated from the last part of each path:
- Spaces and special characters are converted to hyphens
- Names are made lowercase for consistency
- Numbers are appended to resolve duplicates (e.g., 'work-vault-1')

Examples:
  # Valid paths:
  obsidian-mcp ~/Documents/Obsidian/Work ~/Documents/Obsidian/Personal
  → Creates vaults named 'work' and 'personal'

  obsidian-mcp ~/Notes/Work ~/Notes/Archive
  → Creates vaults named 'work' and 'archive'

  # Invalid paths:
  obsidian-mcp ~/Vaults ~/Vaults/Work     # ❌ Paths overlap
  obsidian-mcp ~/Work ~/Work              # ❌ Duplicate paths
  obsidian-mcp ~/                         # ❌ Home directory root
  obsidian-mcp /tmp/vault                 # ❌ System directory
  obsidian-mcp ~/.config/vault            # ❌ Hidden directory
  obsidian-mcp //server/share/vault       # ❌ Network path
  obsidian-mcp /mnt/network/vault         # ❌ Network mount
  obsidian-mcp ~/symlink-to-vault         # ❌ External symlink
`;

  const exitWithCliError = (message: string) => {
    console.error(`Error: ${message}`);
    writeJsonResponse({
      jsonrpc: "2.0",
      error: {
        code: ErrorCode.InvalidRequest,
        message
      },
      id: null
    });
    process.exit(1);
  };

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];

    if (arg === "--") {
      vaultArgs.push(...rawArgs.slice(i + 1));
      break;
    }

    if (!arg.startsWith("--") || arg === "--help" || arg === "-h") {
      if (arg === "--help" || arg === "-h") {
        console.log(buildHelpMessage());
        process.exit(0);
      }

      vaultArgs.push(arg);
      continue;
    }

    const [flag, inlineValue] = arg.split("=", 2);

    const readValue = (name: string): string => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }

      const next = rawArgs[i + 1];
      if (!next || next.startsWith("--")) {
        exitWithCliError(`Missing value for ${name}`);
      }

      i += 1;
      return next;
    };

    switch (flag) {
      case "--transport": {
        const value = readValue(flag).toLowerCase();
        if (value !== "stdio" && value !== "http") {
          exitWithCliError(`Invalid transport "${value}". Supported transports: stdio, http.`);
        }
        cliOptions.transport = value as TransportMode;
        break;
      }
      case "--host": {
        cliOptions.host = readValue(flag);
        break;
      }
      case "--port": {
        const value = Number(readValue(flag));
        if (!Number.isInteger(value) || value < 1 || value > 65535) {
          exitWithCliError(`Invalid port "${value}". Port must be an integer between 1 and 65535.`);
        }
        cliOptions.port = value;
        break;
      }
      case "--http-path": {
        const value = readValue(flag).trim();
        cliOptions.httpPath = value.startsWith("/") ? value : `/${value}`;
        break;
      }
      case "--allowed-origin": {
        cliOptions.allowedOrigins.push(readValue(flag));
        break;
      }
      case "--allowed-host": {
        cliOptions.allowedHosts.push(readValue(flag));
        break;
      }
      case "--enable-dns-rebinding-protection": {
        cliOptions.enableDnsRebindingProtection = true;
        break;
      }
      default: {
        exitWithCliError(`Unknown option: ${flag}`);
      }
    }
  }

  if (vaultArgs.length === 0) {
    const helpMessage = buildHelpMessage();

    // Log help message to stderr for user reference
    console.error(helpMessage);

    // Write MCP error to stdout
    writeJsonResponse({
      jsonrpc: "2.0",
      error: {
        code: ErrorCode.InvalidRequest,
        message: "No vault paths provided. Please provide at least one valid Obsidian vault path."
      },
      id: null
    });

    process.exit(1);
  }

  // Validate and normalize vault paths
  const normalizedPaths = await Promise.all(vaultArgs.map(async (vaultPath, index) => {
    try {
      // Expand home directory if needed
      const expandedPath = vaultPath.startsWith('~') ? 
        path.join(os.homedir(), vaultPath.slice(1)) : 
        vaultPath;
      
      // Normalize and convert to absolute path
      const normalizedPath = path.normalize(expandedPath)
        .replace(/[\/\\]+$/, ''); // Remove trailing slashes
      const absolutePath = path.resolve(normalizedPath);

      // Validate path is absolute and safe
      if (!path.isAbsolute(absolutePath)) {
        const errorMessage = `Vault path must be absolute: ${vaultPath}`;
        console.error(`Error: ${errorMessage}`);
        
        writeJsonResponse({
          jsonrpc: "2.0",
          error: {
            code: ErrorCode.InvalidRequest,
            message: errorMessage
          },
          id: null
        });
        
        process.exit(1);
      }

      // Check for suspicious paths and local filesystem
      const [suspiciousReason, localPathIssue] = await Promise.all([
        checkSuspiciousPath(absolutePath),
        checkLocalPath(absolutePath)
      ]);

      if (localPathIssue) {
        const errorMessage = `Invalid vault path (${localPathIssue}): ${vaultPath}\n` +
          `For reliability and security reasons, vault paths must:\n` +
          `- Be on a local filesystem\n` +
          `- Not use network drives or mounts\n` +
          `- Not contain symlinks that point outside their directory`;
        
        console.error(`Error: ${errorMessage}`);
        
        writeJsonResponse({
          jsonrpc: "2.0",
          error: {
            code: ErrorCode.InvalidRequest,
            message: errorMessage
          },
          id: null
        });
        
        process.exit(1);
      }

      if (suspiciousReason) {
        const errorMessage = `Invalid vault path (${suspiciousReason}): ${vaultPath}\n` +
          `For security reasons, vault paths cannot:\n` +
          `- Point to system directories\n` +
          `- Use hidden directories (except .obsidian)\n` +
          `- Point to the home directory root\n` +
          `Please choose a dedicated directory for your vault`;
        
        console.error(`Error: ${errorMessage}`);
        
        writeJsonResponse({
          jsonrpc: "2.0",
          error: {
            code: ErrorCode.InvalidRequest,
            message: errorMessage
          },
          id: null
        });
        
        process.exit(1);
      }

      try {
        // Check if path exists and is a directory
        const stats = await fs.stat(absolutePath);
        if (!stats.isDirectory()) {
          const errorMessage = `Vault path must be a directory: ${vaultPath}`;
          console.error(`Error: ${errorMessage}`);
          
          writeJsonResponse({
            jsonrpc: "2.0",
            error: {
              code: ErrorCode.InvalidRequest,
              message: errorMessage
            },
            id: null
          });
          
          process.exit(1);
        }

        // Check if path is readable and writable
        await fs.access(absolutePath, fsConstants.R_OK | fsConstants.W_OK);

        // Check if this is a valid Obsidian vault
        const obsidianConfigPath = path.join(absolutePath, '.obsidian');
        const obsidianAppConfigPath = path.join(obsidianConfigPath, 'app.json');
        
        try {
          // Check .obsidian directory
          const configStats = await fs.stat(obsidianConfigPath);
          if (!configStats.isDirectory()) {
            const errorMessage = `Invalid Obsidian vault configuration in ${vaultPath}\n` +
              `The .obsidian folder exists but is not a directory\n` +
              `Try removing it and reopening the vault in Obsidian`;
            
            console.error(`Error: ${errorMessage}`);
            
            writeJsonResponse({
              jsonrpc: "2.0",
              error: {
                code: ErrorCode.InvalidRequest,
                message: errorMessage
              },
              id: null
            });
            
            process.exit(1);
          }

          // Check app.json to verify it's properly initialized
          await fs.access(obsidianAppConfigPath, fsConstants.R_OK);
          
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            const errorMessage = `Not a valid Obsidian vault (${vaultPath})\n` +
              `Missing or incomplete .obsidian configuration\n\n` +
              `To fix this:\n` +
              `1. Open Obsidian\n` +
              `2. Click "Open folder as vault"\n` +
              `3. Select the directory: ${absolutePath}\n` +
              `4. Wait for Obsidian to initialize the vault\n` +
              `5. Try running this command again`;
            
            console.error(`Error: ${errorMessage}`);
            
            writeJsonResponse({
              jsonrpc: "2.0",
              error: {
                code: ErrorCode.InvalidRequest,
                message: errorMessage
              },
              id: null
            });
          } else {
            const errorMessage = `Error checking Obsidian configuration in ${vaultPath}: ${error instanceof Error ? error.message : String(error)}`;
            console.error(`Error: ${errorMessage}`);
            
            writeJsonResponse({
              jsonrpc: "2.0",
              error: {
                code: ErrorCode.InternalError,
                message: errorMessage
              },
              id: null
            });
          }
          process.exit(1);
        }

        return absolutePath;
      } catch (error) {
        let errorMessage: string;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          errorMessage = `Vault directory does not exist: ${vaultPath}`;
        } else if ((error as NodeJS.ErrnoException).code === 'EACCES') {
          errorMessage = `No permission to access vault directory: ${vaultPath}`;
        } else {
          errorMessage = `Error accessing vault path ${vaultPath}: ${error instanceof Error ? error.message : String(error)}`;
        }
        
        console.error(`Error: ${errorMessage}`);
        
        writeJsonResponse({
          jsonrpc: "2.0",
          error: {
            code: ErrorCode.InvalidRequest,
            message: errorMessage
          },
          id: null
        });
        
        process.exit(1);
      }
    } catch (error) {
      const errorMessage = `Error processing vault path ${vaultPath}: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`Error: ${errorMessage}`);
      
      writeJsonResponse({
        jsonrpc: "2.0",
        error: {
          code: ErrorCode.InternalError,
          message: errorMessage
        },
        id: null
      });
      
      process.exit(1);
    }
  }));

  // Validate number of vaults
  if (vaultArgs.length > MAX_VAULTS) {
    const errorMessage = `Too many vaults specified (${vaultArgs.length})\n` +
      `Maximum number of vaults allowed: ${MAX_VAULTS}\n` +
      `This limit helps prevent performance issues and resource exhaustion`;
    
    console.error(`Error: ${errorMessage}`);
    
    writeJsonResponse({
      jsonrpc: "2.0",
      error: {
        code: ErrorCode.InvalidRequest,
        message: errorMessage
      },
      id: null
    });
    
    process.exit(1);
  }

  console.error(`Validating ${vaultArgs.length} vault path${vaultArgs.length > 1 ? 's' : ''}...`);

  // Check if we have any valid paths
  if (normalizedPaths.length === 0) {
    const errorMessage = `No valid vault paths provided\n` +
      `Make sure at least one path points to a valid Obsidian vault`;
    
    console.error(`\nError: ${errorMessage}`);
    
    writeJsonResponse({
      jsonrpc: "2.0",
      error: {
        code: ErrorCode.InvalidRequest,
        message: errorMessage
      },
      id: null
    });
    
    process.exit(1);
  } else if (normalizedPaths.length < vaultArgs.length) {
    console.error(`\nWarning: Only ${normalizedPaths.length} out of ${vaultArgs.length} paths were valid`);
    console.error("Some vaults will not be available");
  }

  try {
    // Check for overlapping vault paths
    checkPathOverlap(normalizedPaths);
  } catch (error) {
    const errorMessage = error instanceof McpError ? error.message : String(error);
    console.error(`Error: ${errorMessage}`);
    
    writeJsonResponse({
      jsonrpc: "2.0",
      error: {
        code: ErrorCode.InvalidRequest,
        message: errorMessage
      },
      id: null
    });
    
    process.exit(1);
  }

  // Create vault configurations with human-friendly names
  console.error("\nInitializing vaults...");
  const vaults: VaultConfig[] = normalizedPaths.map(vaultPath => {
    // Get the last directory name from the path as the vault name
    const rawName = path.basename(vaultPath);
    const vaultName = sanitizeVaultName(rawName);
    
    // Log the vault name mapping for user reference
    console.error(`Vault "${rawName}" registered as "${vaultName}"`);
    
    return {
      name: vaultName,
      path: vaultPath
    };
  });

  // Ensure vault names are unique by appending numbers if needed
  const uniqueVaults: VaultConfig[] = [];
  const usedNames = new Set<string>();

  vaults.forEach(vault => {
    let uniqueName = vault.name;
    let counter = 1;
    
    // If name is already used, find a unique variant
    if (usedNames.has(uniqueName)) {
      console.error(`Note: Found duplicate vault name "${uniqueName}"`);
      while (usedNames.has(uniqueName)) {
        uniqueName = `${vault.name}-${counter}`;
        counter++;
      }
      console.error(`  → Using "${uniqueName}" instead`);
    }
    
    usedNames.add(uniqueName);
    uniqueVaults.push({
      name: uniqueName,
      path: vault.path
    });
  });

  // Log final vault configuration to stderr
  console.error("\nSuccessfully configured vaults:");
  uniqueVaults.forEach(vault => {
    console.error(`- ${vault.name}`);
    console.error(`  Path: ${vault.path}`);
  });
  console.error(`\nTotal vaults: ${uniqueVaults.length}`);
  console.error(""); // Empty line for readability

  try {
    if (uniqueVaults.length === 0) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'No valid Obsidian vaults provided. Please provide at least one valid vault path.\n\n' +
        'Example usage:\n' +
        '  obsidian-mcp ~/Documents/Obsidian/MyVault\n\n' +
        'The vault directory must:\n' +
        '- Exist and be accessible\n' +
        '- Contain a .obsidian directory (initialize by opening in Obsidian first)\n' +
        '- Have read/write permissions'
      );
    }

    console.error(`Starting Obsidian MCP Server with ${uniqueVaults.length} vault${uniqueVaults.length > 1 ? 's' : ''}...`);

    if (cliOptions.transport === "http") {
      console.error(`HTTP transport enabled on ${cliOptions.host}:${cliOptions.port}${cliOptions.httpPath}`);
      if (!cliOptions.enableDnsRebindingProtection && cliOptions.allowedHosts.length === 0 && cliOptions.allowedOrigins.length === 0) {
        console.error("Warning: No DNS rebinding protection configured. Use --allowed-host/--allowed-origin with --enable-dns-rebinding-protection when exposing the server to untrusted networks.");
      }
    }

    const server = new ObsidianServer(uniqueVaults);
    console.error("Server initialized successfully");

    // Handle graceful shutdown
    let isShuttingDown = false;
    async function shutdown(signal: string) {
      if (isShuttingDown) return;
      isShuttingDown = true;

      console.error(`\nReceived ${signal}, shutting down...`);
      try {
        await server.stop();
        console.error("Server stopped cleanly");
        process.exit(0);
      } catch (error) {
        console.error("Error during shutdown:", error);
        process.exit(1);
      }
    }

    // Register signal handlers
    process.on('SIGINT', () => shutdown('SIGINT')); // Ctrl+C
    process.on('SIGTERM', () => shutdown('SIGTERM')); // Kill command

    // Create vaults Map from unique vaults
    const vaultsMap = new Map(uniqueVaults.map(v => [v.name, v.path]));

    // Register tools with unique vault names
    const tools = [
      createCreateNoteTool(vaultsMap),
      createListAvailableVaultsTool(vaultsMap),
      createEditNoteTool(vaultsMap),
      createSearchVaultTool(vaultsMap),
      createMoveNoteTool(vaultsMap),
      createCreateDirectoryTool(vaultsMap),
      createDeleteNoteTool(vaultsMap),
      createAddTagsTool(vaultsMap),
      createRemoveTagsTool(vaultsMap),
      createRenameTagTool(vaultsMap),
      createReadNoteTool(vaultsMap)
    ];

    for (const tool of tools) {
      try {
        server.registerTool(tool);
      } catch (error) {
        console.error(`Error registering tool ${tool.name}:`, error);
        throw error;
      }
    }

    // All prompts are registered in the server constructor
    console.error("All tools registered successfully");
    console.error("Server starting...\n");

    // Start the server without logging to stdout
    const transportConfig = cliOptions.transport === "http"
      ? {
        type: "http" as const,
        host: cliOptions.host,
        port: cliOptions.port,
        path: cliOptions.httpPath,
        allowedOrigins: cliOptions.allowedOrigins,
        allowedHosts: cliOptions.allowedHosts,
        enableDnsRebindingProtection: cliOptions.enableDnsRebindingProtection
      }
      : { type: "stdio" as const };

    await server.start(transportConfig);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    // Format error for MCP protocol
    const mcpError = error instanceof McpError ? error : new McpError(
      ErrorCode.InternalError,
      error instanceof Error ? error.message : String(error)
    );

    // Write error in MCP protocol format to stdout
    writeJsonResponse({
      jsonrpc: "2.0",
      error: {
        code: mcpError.code,
        message: mcpError.message
      },
      id: null
    });

    // Log details to stderr for debugging
    console.error("\nFatal error starting server:");
    console.error(mcpError.message);
    if (error instanceof Error && error.stack) {
      console.error("\nStack trace:");
      console.error(error.stack.split('\n').slice(1).join('\n'));
    }
    
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
