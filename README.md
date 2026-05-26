# MCP Gateway Server

HTTP JSON-RPC gateway that manages multiple MCP tool servers and exposes them to frontend clients.

## Architecture

```txt
Frontend / Service
  └── HTTP JSON-RPC (POST /mcp) ──► Gateway (port 3002)
                                        ├── calculator (stdio)
                                        ├── filesystem (stdio)
                                        └── [add more in config.json]
```

## Quick Start

```bash
cd mcp-server
npm install
cp .env.example .env
npm run dev        # development (nodemon)
npm start          # production
```

## Add a New MCP Server

1. Create `servers/<name>/index.js` (see `servers/calculator/index.js` as template)
2. Add entry to `config.json` (local stdio):
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

## Register a Third-Party MCP (Streamable HTTP)

If the MCP provider exposes an HTTP JSON-RPC endpoint, register it directly:

```json

{
    "id": "third-party-mcp",
    "name": "Third Party MCP",
    "description": "Remote MCP over streamable HTTP",
    "type": "streamable-http",
    "url": "https://apim-gateway.pkulaw.com/mcp-law-search-service",
    "auth": {
        "envHeaders": {
            "authorization": "THIRD_PARTY_MCP_AUTH"
        }
    },
    "autoStart": true,
    "enabled": true
}
```

Then set environment variable:

```bash
export THIRD_PARTY_MCP_AUTH="Bearer <token>"
```

Notes:
- `auth.headers`: fixed headers written in config.
- `auth.envHeaders`: `headerName -> ENV_VAR_NAME`, resolved at runtime.
- Remote server receives standard JSON-RPC methods like `initialize`, `tools/list`, `tools/call`.

## HTTP API

### 1) Health

`GET /health`

### 2) List registered MCP servers

`GET /servers`

### 3) List tools of a server

`GET /servers/:serverId/tools`

### 4) JSON-RPC endpoint

`POST /mcp`

Single request example:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "gateway/list_servers" }
```

Call a tool:
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "serverId": "calculator",
  "params": { "name": "add", "arguments": { "a": 5, "b": 3 } }
}
```

### Request-scoped auth passthrough (no persistence)

For remote `streamable-http` MCP servers, you can pass temporary auth headers per request:

- Send gateway headers like `x-mcp-auth-authorization`, `x-mcp-auth-x-api-key`
- Gateway strips prefix and forwards them to target MCP only for this request
- No DB/config persistence

Example:

```http
POST /mcp
x-mcp-auth-authorization: Bearer <short-lived-token>
```

## Admin API (for backend proxy)

Use these endpoints from your backend service, not from browser directly.

### Auth

If `MCP_ADMIN_TOKEN` is set, send:

`Authorization: Bearer <MCP_ADMIN_TOKEN>`

### Endpoints

- `GET /admin/servers` list runtime servers with config
- `POST /admin/servers/register` register or update a server
- `POST /admin/servers/unregister` remove a server
- `POST /admin/servers/start` start a server
- `POST /admin/servers/stop` stop a server

Register request body:

```json
{
  "config": {
    "id": "third-party-mcp",
    "name": "Third Party MCP",
    "description": "Remote MCP over streamable HTTP",
    "type": "streamable-http",
    "url": "https://example.com/mcp",
    "auth": {
      "headers": {
        "x-tenant-id": "tenant-a"
      },
      "envHeaders": {
        "authorization": "THIRD_PARTY_MCP_AUTH"
      }
    },
    "autoStart": true,
    "enabled": true
  }
}
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
| `PORT` | `3002` | HTTP server port |
| `ALLOWED_ORIGINS` | (empty = allow all) | Comma-separated allowed origins |
| `MCP_FS_BASE_DIR` | `./workspace` | Filesystem server workspace root |
| `MCP_ADMIN_TOKEN` | (empty) | Optional token required for `/admin/*` endpoints |
| `THIRD_PARTY_MCP_AUTH` | (empty) | Example bearer token for `auth.envHeaders.authorization` |
| `MCP_PASSTHROUGH_AUTH_HEADERS` | `authorization,x-api-key` | Allowed target header names for `x-mcp-auth-*` passthrough |

## Health Check

```
GET http://localhost:3002/health
```

Returns server list with status.
