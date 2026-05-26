'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');

const MCPServerManager = require('./manager');
const MessageRouter = require('./router');

const manager = new MCPServerManager();
const router = new MessageRouter(manager);

function createCorsOptions() {
  if (config.allowedOrigins.length === 0) {
    return { origin: true };
  }
  return {
    origin(origin, callback) {
      if (!origin || config.allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Origin not allowed'));
    },
  };
}

function parseJsonRpcMessage(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') return null;
  return body;
}

function validateServerConfig(serverConfig) {
  if (!serverConfig || typeof serverConfig !== 'object') throw new Error('Invalid config payload');
  if (!serverConfig.id || typeof serverConfig.id !== 'string') throw new Error('config.id is required');
  if (!serverConfig.name || typeof serverConfig.name !== 'string') throw new Error('config.name is required');
  if (serverConfig.tag !== undefined && typeof serverConfig.tag !== 'string') {
    throw new Error('config.tag must be a string');
  }

  const type = serverConfig.type || 'stdio';
  if (!['stdio', 'streamable-http'].includes(type)) {
    throw new Error('config.type must be "stdio" or "streamable-http"');
  }

  if (type === 'stdio') {
    if (!serverConfig.command || typeof serverConfig.command !== 'string') {
      throw new Error('stdio config.command is required');
    }
    if (serverConfig.args && !Array.isArray(serverConfig.args)) {
      throw new Error('stdio config.args must be an array');
    }
  }

  if (type === 'streamable-http') {
    if (!serverConfig.url || typeof serverConfig.url !== 'string') {
      throw new Error('streamable-http config.url is required');
    }
  }
}

function requireAdmin(req, res, next) {
  if (!config.mcpAdminToken) {
    next();
    return;
  }

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== config.mcpAdminToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

function extractPassthroughAuthHeaders(req) {
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(req.headers || {})) {
    const name = String(rawName || '').toLowerCase();
    if (!name.startsWith('x-mcp-auth-')) continue;
    const target = name.slice('x-mcp-auth-'.length).trim().toLowerCase();
    if (!target) continue;
    headers[target] = Array.isArray(rawValue) ? rawValue.join(',') : String(rawValue);
  }
  return headers;
}

async function loadConfig() {
  if (config.disableAutoRegister) {
    console.log('[gateway] Auto register disabled by MCP_DISABLE_AUTO_REGISTER=true');
    return;
  }

  let configData;
  try {
    configData = require(config.configFile);
  } catch (err) {
    throw new Error(`Failed to load config file ${config.configFile}: ${err.message}`);
  }

  if (!configData || !Array.isArray(configData.servers)) {
    throw new Error('Invalid config file format; expected { servers: [] }');
  }

  for (const serverConfig of configData.servers) {
    if (serverConfig.enabled !== false) {
      await manager.register(serverConfig);
    }
  }
  console.log(`[gateway] Registered ${configData.servers.length} server(s)`);
}

const app = express();
app.use(cors(createCorsOptions()));
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', servers: manager.listServers() });
});

app.get('/servers', (_req, res) => {
  res.json({ servers: manager.listServers() });
});

app.get('/admin/servers', requireAdmin, (_req, res) => {
  const servers = manager.listServers().map((s) => ({
    ...s,
    config: manager.getServerConfig(s.id),
  }));
  res.json({ servers });
});

app.post('/admin/servers/register', requireAdmin, async (req, res) => {
  try {
    const serverConfig = req.body?.config;
    validateServerConfig(serverConfig);
    await manager.registerOrUpdate(serverConfig);
    res.json({ ok: true, server: manager.listServers().find((s) => s.id === serverConfig.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/admin/servers/unregister', requireAdmin, (req, res) => {
  try {
    const serverId = req.body?.serverId;
    if (!serverId || typeof serverId !== 'string') {
      throw new Error('serverId is required');
    }
    manager.unregister(serverId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/admin/servers/start', requireAdmin, async (req, res) => {
  try {
    const serverId = req.body?.serverId;
    if (!serverId || typeof serverId !== 'string') {
      throw new Error('serverId is required');
    }
    await manager.start(serverId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/admin/servers/stop', requireAdmin, (req, res) => {
  try {
    const serverId = req.body?.serverId;
    if (!serverId || typeof serverId !== 'string') {
      throw new Error('serverId is required');
    }
    manager.stop(serverId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/servers/:serverId/tools', async (req, res) => {
  try {
    const passthroughAuthHeaders = extractPassthroughAuthHeaders(req);
    const result = await manager.sendRequest(
      req.params.serverId,
      'tools/list',
      {},
      undefined,
      { passthroughAuthHeaders }
    );
    res.json({ serverId: req.params.serverId, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/mcp', async (req, res) => {
  const payload = req.body;
  const passthroughAuthHeaders = extractPassthroughAuthHeaders(req);

  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    const responses = await Promise.all(payload.map(async (msg) => {
      const parsed = parseJsonRpcMessage(msg);
      if (!parsed) {
        return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
      }
      try {
        return await router.route(parsed, { passthroughAuthHeaders });
      } catch (err) {
        return { jsonrpc: '2.0', id: parsed.id ?? null, error: { code: -32000, message: err.message } };
      }
    }));
    res.json(responses);
    return;
  }

  const message = parseJsonRpcMessage(payload);
  if (!message) {
    res.status(400).json({ jsonrpc: '2.0', id: payload?.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }

  try {
    const response = await router.route(message, { passthroughAuthHeaders });
    res.json(response);
  } catch (err) {
    res.status(500).json({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32000, message: err.message } });
  }
});

module.exports = { app, loadConfig, manager };
