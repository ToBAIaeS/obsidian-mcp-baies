# Using Obsidian MCP with ChatGPT Desktop

ChatGPT Desktop (macOS and Windows) requires MCP servers to be reachable over HTTP(S). Run `obsidian-mcp` in HTTP mode on a machine that has access to your vaults, then register the remote endpoint inside ChatGPT.

## Prerequisites

- Node.js 20 or later installed locally
- `npx` accessible from your system `PATH`
- One or more initialized Obsidian vaults (each must contain a `.obsidian` directory)

## Configuration Steps

1. **Start the server in HTTP mode** on the host that can access your vault:

   ```bash
   npx -y obsidian-mcp --transport=http --host 0.0.0.0 --port 8080 --http-path /mcp /absolute/path/to/your/vault [/absolute/path/to/another/vault]
   ```

   - `--host` controls the network interface. Use `127.0.0.1` when tunnelling the port, or `0.0.0.0` when binding publicly.
   - `--port` and `--http-path` must match the URL you will expose to ChatGPT Desktop.
   - For public deployments, combine `--allowed-origin`, `--allowed-host`, and `--enable-dns-rebinding-protection`, and front the process with TLS (reverse proxy, Cloudflare Tunnel, etc.).

2. **Expose the endpoint** so ChatGPT can reach it. Map the external URL (e.g. `https://notes.example.com/mcp`) to the host, port, and path you configured above.

3. **Register the remote server** in ChatGPT Desktop:
   - Open **Settings → General → Model Context Protocol**.
   - Choose **Add remote server**.
   - Provide a name such as `Obsidian`.
   - Set the URL to your published endpoint (e.g. `https://notes.example.com/mcp`).
   - (Optional) Add HTTP headers if your proxy enforces authentication.
   - Save the configuration. The entry should display a green indicator once the handshake succeeds.

## Troubleshooting

- **Endpoint unreachable:** Confirm that firewalls, tunnels, and DNS point to the host/port where `obsidian-mcp` is listening. From a shell, run `curl https://notes.example.com/mcp` and ensure you receive a JSON-RPC response (HTTP 405/400 is expected for GET requests without headers).
- **Vault not recognized:** Make sure the path is absolute and the vault has been opened once in Obsidian so the `.obsidian` folder exists.
- **Permission issues:** The account running the MCP server must have read/write access to the vault directory. On macOS, grant the process Full Disk Access if required.
- **Inspecting logs:** Review stdout/stderr wherever you started the process, or use the **View logs** link next to the server in ChatGPT Desktop to inspect transport logs.

Once configured, you can invoke tools such as `list-available-vaults`, `read-note`, or `create-note` directly from ChatGPT conversations.
