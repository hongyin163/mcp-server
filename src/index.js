'use strict';

require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');

const MCPServerManager = require('./manager');
const MessageRouter = require('./router');

const PORT = process.env.PORT || 3002;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

// ─── Express app (health check) ──────────────────────────────────────────────
const app = express();

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', servers: manager.listServers() });
});

// ─── MCP Server Manager ───────────────────────────────────────────────────────
const manager = new MCPServerManager();
const router = new MessageRouter(manager);

// Load config and register servers
async function loadConfig() {
    const config = require(path.resolve(__dirname, '../config.json'));
    for (const serverConfig of config.servers) {
        if (serverConfig.enabled !== false) {
            await manager.register(serverConfig);
        }
    }
    console.log(`[gateway] Registered ${config.servers.length} server(s)`);
}

// ─── HTTP + WebSocket server ──────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    // Origin check
    const origin = req.headers.origin || '';
    if (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(origin)) {
        console.warn(`[gateway] Rejected connection from origin: ${origin}`);
        ws.close(1008, 'Origin not allowed');
        return;
    }

    console.log(`[gateway] Client connected from ${req.socket.remoteAddress}`);

    // Send server list immediately on connect
    const servers = manager.listServers();
    ws.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'gateway/server_list',
        params: { servers },
    }));

    ws.on('message', async (data) => {
        let message;
        try {
            message = JSON.parse(data.toString());
        } catch {
            ws.send(JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32700, message: 'Parse error' },
            }));
            return;
        }

        try {
            const response = await router.route(message);
            ws.send(JSON.stringify(response));
        } catch (err) {
            ws.send(JSON.stringify({
                jsonrpc: '2.0',
                id: message.id ?? null,
                error: { code: -32000, message: err.message },
            }));
        }
    });

    ws.on('close', () => {
        console.log(`[gateway] Client disconnected`);
    });

    ws.on('error', (err) => {
        console.error(`[gateway] WebSocket error: ${err.message}`);
    });
});

// ─── Start ────────────────────────────────────────────────────────────────────
loadConfig()
    .then(() => {
        server.listen(PORT, () => {
            console.log(`[gateway] MCP Gateway running on ws://localhost:${PORT}`);
            console.log(`[gateway] Health check: http://localhost:${PORT}/health`);
        });
    })
    .catch((err) => {
        console.error('[gateway] Failed to start:', err);
        process.exit(1);
    });

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('[gateway] Shutting down...');
    wss.close();
    server.close(() => process.exit(0));
});
