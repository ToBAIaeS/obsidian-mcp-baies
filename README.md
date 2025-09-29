# Obsidian MCP Server

[![smithery badge](https://smithery.ai/badge/obsidian-mcp)](https://smithery.ai/server/obsidian-mcp)

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that enables AI assistants to interact with Obsidian vaults, providing tools for reading, creating, editing and managing notes and tags.

## Warning!!!

This MCP has read and write access (if you allow it). Please. PLEASE backup your Obsidian vault prior to using obsidian-mcp to manage your notes. I recommend using git, but any backup method will work. These tools have been tested, but not thoroughly, and this MCP is in active development.

## Features

- Read and search notes in your vault
- Create new notes and directories
- Edit existing notes
- Move and delete notes
- Manage tags (add, remove, rename)
- Search vault contents

## Requirements

- Node.js 20 or higher (might work on lower, but I haven't tested it)
- An Obsidian vault

## Install

### Installing Manually

Add to your Claude Desktop configuration:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
    "mcpServers": {
        "obsidian": {
            "command": "npx",
            "args": ["-y", "obsidian-mcp", "/path/to/your/vault", "/path/to/your/vault2"]
        }
    }
}
```

Replace `/path/to/your/vault` with the absolute path to your Obsidian vault. For example:

MacOS/Linux:

```json
"/Users/username/Documents/MyVault"
```

Windows:

```json
"C:\\Users\\username\\Documents\\MyVault"
```

Restart Claude for Desktop after saving the configuration. You should see the hammer icon appear, indicating the server is connected.

If you have connection issues, check the logs at:

- MacOS: `~/Library/Logs/Claude/mcp*.log`
- Windows: `%APPDATA%\Claude\logs\mcp*.log`

### Using with ChatGPT Desktop

ChatGPT Desktop (macOS/Windows) currently supports **remote** MCP servers only. Run Obsidian MCP in HTTP mode on a machine that can reach your vault, then register the remote endpoint inside ChatGPT:

1. **Start the server in HTTP mode** on the machine that hosts your vaults:

   ```bash
   npx -y obsidian-mcp --transport=http --host 0.0.0.0 --port 8080 --http-path /mcp /absolute/path/to/your/vault [/absolute/path/to/another/vault]
   ```

   - Adjust `--host`, `--port`, and `--http-path` to match your networking and reverse-proxy setup.
   - For public deployments, place the process behind TLS and restrict access with firewalls, VPNs, or tunnels. Combine `--allowed-host`, `--allowed-origin`, and `--enable-dns-rebinding-protection` to lock down inbound requests.

2. **Expose the endpoint** so ChatGPT Desktop can reach it (e.g., via HTTPS reverse proxy, secure tunnel, or VPN). The external URL should map to the path supplied in `--http-path`.

3. **Register the remote server** inside ChatGPT:
   - Open **Settings → General → Model Context Protocol**.
   - Click **Add remote server**.
   - Enter a name (for example, `Obsidian`).
   - Set the URL to your published endpoint, such as `https://notes.example.com/mcp`.
   - (Optional) Add HTTP headers if your proxy requires authentication.
   - Save the configuration. The entry should show a green indicator once the handshake succeeds.

> [!TIP]
> After adding the server, select it in the Model Context Protocol panel and run `list-available-vaults` to confirm ChatGPT can reach your vaults.

Troubleshooting tips for ChatGPT Desktop:

- Verify that the HTTP endpoint is reachable from ChatGPT’s network (open firewall ports or establish a tunnel).
- Ensure the vault path on the host machine is absolute, writable, and already initialized by Obsidian (contains `.obsidian`).
- Check the server logs in your hosting environment or via the **View logs** link in ChatGPT to inspect stdout/stderr output.


### Installing via Smithery
Warning: I am not affiliated with Smithery. I have not tested using it and encourage users to install manually if they can.

To install Obsidian for Claude Desktop automatically via [Smithery](https://smithery.ai/server/obsidian-mcp):

```bash
npx -y @smithery/cli install obsidian-mcp --client claude
```

## Development

```bash
# Clone the repository
git clone https://github.com/StevenStavrakis/obsidian-mcp
cd obsidian-mcp

# Install dependencies
npm install

# Build
npm run build
```

Then add to your Claude Desktop configuration:

```json
{
    "mcpServers": {
        "obsidian": {
            "command": "node",
            "args": ["<absolute-path-to-obsidian-mcp>/build/main.js", "/path/to/your/vault", "/path/to/your/vault2"]
        }
    }
}
```

## Available Tools

- `read-note` - Read the contents of a note
- `create-note` - Create a new note
- `edit-note` - Edit an existing note
- `delete-note` - Delete a note
- `move-note` - Move a note to a different location
- `create-directory` - Create a new directory
- `search-vault` - Search notes in the vault
- `add-tags` - Add tags to a note
- `remove-tags` - Remove tags from a note
- `rename-tag` - Rename a tag across all notes
- `manage-tags` - List and organize tags
- `list-available-vaults` - List all available vaults (helps with multi-vault setups)

## Documentation

Additional documentation can be found in the `docs` directory:

- `creating-tools.md` - Guide for creating new tools
- `tool-examples.md` - Examples of using the available tools
- `chatgpt-setup.md` - Step-by-step guide for configuring the server with ChatGPT Desktop

## Security

This server requires access to your Obsidian vault directory. When configuring the server, make sure to:

- Only provide access to your intended vault directory
- Review tool actions before approving them

## Troubleshooting

Common issues:

1. **Server not showing up in Claude Desktop**
   - Verify your configuration file syntax
   - Make sure the vault path is absolute and exists
   - Restart Claude Desktop

2. **Permission errors**
   - Ensure the vault path is readable/writable
   - Check file permissions in your vault

3. **Tool execution failures**
   - Check Claude Desktop logs at:
     - macOS: `~/Library/Logs/Claude/mcp*.log`
     - Windows: `%APPDATA%\Claude\logs\mcp*.log`

## License

MIT
