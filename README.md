# MCP Gateway Server

WebSocket gateway that manages multiple MCP tool servers and exposes them to the browser-based Agent framework.

## Architecture

```
Browser (Agent Framework)
  └── MCPClient (WebSocket) ──► Gateway (port 3002)
                                    ├── calculator (stdio)
                                    ├── filesystem (stdio)
                                    └── [add more in config.json]
```

## Quick Start

```bash
cd mcp-server
npm install
npm run dev        # development (nodemon)
npm start          # production
```

## Add a New MCP Server

1. Create `servers/<name>/index.js` (see `servers/calculator/index.js` as template)
2. Add entry to `config.json`:
```json
{
  "id": "my-server",
  "name": "My Server",
  "description": "What it does",
  "type": "stdio",
  "command": "node",
  "args": ["servers/my-server/index.js"],
  "autoStart": true,
  "enabled": true
}
```
3. Restart the gateway — tools are auto-discovered.

## WebSocket Protocol

All messages are JSON-RPC 2.0. Client messages include a `serverId` field:

```json
// List all registered servers
{ "jsonrpc": "2.0", "id": 1, "method": "gateway/list_servers" }

// List tools from a server
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "serverId": "calculator" }

// Call a tool
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "serverId": "calculator",
  "params": { "name": "add", "arguments": { "a": 5, "b": 3 } } }
```

On connect, the gateway immediately sends:
```json
{ "jsonrpc": "2.0", "method": "gateway/server_list", "params": { "servers": [...] } }
```

## Deploy to Alibaba Cloud ECS

### Option A: PM2

```bash
npm install -g pm2
npm install
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # auto-start on reboot
```

### Option B: Docker

```bash
docker build -t mcp-gateway .
docker run -d -p 3002:3002 --name mcp-gateway mcp-gateway
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3002` | WebSocket server port |
| `ALLOWED_ORIGINS` | (empty = allow all) | Comma-separated allowed origins |
| `MCP_FS_BASE_DIR` | `./workspace` | Filesystem server workspace root |

## Health Check

```
GET http://localhost:3002/health
```

Returns server list with status.
