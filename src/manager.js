'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');

const DEFAULT_TIMEOUT = 30000;
const PASSTHROUGH_ALLOWED_HEADERS = config.passthroughAuthHeaders;

/**
 * MCPServerManager
 * Manages both stdio-based and streamable-http MCP backends.
 */
class MCPServerManager {
    constructor() {
        this.servers = new Map();
    }

    /**
     * @param {object} config
     */
    async register(config) {
        if (this.servers.has(config.id)) {
            throw new Error(`Server "${config.id}" already registered`);
        }
        return this.registerOrUpdate(config);
    }

    /**
     * Register or update a server config in place.
     * If the server exists, it is stopped first and then replaced.
     * @param {object} config
     */
    async registerOrUpdate(config) {
        if (this.servers.has(config.id)) {
            this.stop(config.id);
            this.servers.delete(config.id);
        }

        const type = config.type || 'stdio';
        const entry = {
            config: { ...config, type },
            process: null,
            status: 'stopped',
            capabilities: null,
            pending: new Map(),
            buffer: '',
        };

        this.servers.set(config.id, entry);

        if (config.autoStart) {
            try {
                await this.start(config.id);
            } catch (err) {
                // Keep server registered even if startup/initialize fails
                // (e.g. remote MCP requires user-provided API key later).
                entry.status = 'error';
                console.warn(`[manager] Server "${config.id}" registered but failed to auto-start: ${err.message}`);
            }
        }
    }

    /**
     * Remove a server from registry and stop it if running.
     * @param {string} serverId
     */
    unregister(serverId) {
        if (!this.servers.has(serverId)) {
            throw new Error(`Server "${serverId}" not registered`);
        }
        this.stop(serverId);
        this.servers.delete(serverId);
    }

    /**
     * @param {string} serverId
     */
    async start(serverId, options = {}) {
        const entry = this.servers.get(serverId);
        if (!entry) throw new Error(`Server "${serverId}" not registered`);
        if (entry.status === 'running') return;

        const { type } = entry.config;
        if (type === 'stdio') {
            await this._startStdio(serverId, entry, options);
            return;
        }
        if (type === 'streamable-http') {
            await this._startStreamableHttp(serverId, entry, options);
            return;
        }
        throw new Error(`Unsupported server type "${type}" for "${serverId}"`);
    }

    /**
     * @param {string} serverId
     */
    stop(serverId) {
        const entry = this.servers.get(serverId);
        if (!entry) return;

        if (entry.config.type === 'stdio' && entry.process) {
            entry.process.kill();
            entry.process = null;
        }

        entry.status = 'stopped';
    }

    /**
     * @param {string} serverId
     * @param {string} method
     * @param {object} params
     * @param {number} [timeout=30000]
     * @returns {Promise<any>}
     */
    async sendRequest(serverId, method, params, timeout = DEFAULT_TIMEOUT, options = {}) {
        const entry = this.servers.get(serverId);
        if (!entry) throw new Error(`Server "${serverId}" not registered`);
        if (entry.status !== 'running') await this.start(serverId, options);

        if (entry.config.type === 'stdio') {
            return this._sendRequestToStdio(serverId, method, params, timeout);
        }
        if (entry.config.type === 'streamable-http') {
            return this._sendRequestToHttp(serverId, method, params, timeout, options);
        }
        throw new Error(`Unsupported server type "${entry.config.type}" for "${serverId}"`);
    }

    listServers() {
        return Array.from(this.servers.values()).map(({ config, status, capabilities }) => ({
            id: config.id,
            name: config.name,
            description: config.description,
            tag: config.tag || 'default',
            type: config.type,
            status,
            capabilities,
            enabled: config.enabled,
        }));
    }

    /**
     * @param {string} serverId
     */
    getServerConfig(serverId) {
        const entry = this.servers.get(serverId);
        if (!entry) return null;
        return { ...entry.config };
    }

    async _startStdio(serverId, entry, options = {}) {
        const { config } = entry;
        const cwd = path.resolve(__dirname, '..');
        console.log(`[manager] Starting stdio server "${serverId}": ${config.command} ${(config.args || []).join(' ')}`);

        const proc = spawn(config.command, config.args || [], {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...(config.env || {}) },
        });

        proc.stderr.on('data', (data) => {
            console.error(`[${serverId}] stderr: ${data.toString().trim()}`);
        });

        proc.stdout.on('data', (data) => {
            entry.buffer += data.toString();
            const lines = entry.buffer.split('\n');
            entry.buffer = lines.pop();
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    this._handleResponse(serverId, JSON.parse(trimmed));
                } catch (_err) {
                    console.error(`[${serverId}] Failed to parse message: ${trimmed}`);
                }
            }
        });

        proc.on('exit', (code) => {
            console.log(`[manager] Server "${serverId}" exited with code ${code}`);
            entry.status = 'stopped';
            entry.process = null;
            for (const [, req] of entry.pending) {
                clearTimeout(req.timeout);
                req.reject(new Error(`Server "${serverId}" exited`));
            }
            entry.pending.clear();
        });

        proc.on('error', (err) => {
            console.error(`[manager] Server "${serverId}" error: ${err.message}`);
            entry.status = 'error';
        });

        entry.process = proc;
        entry.status = 'running';

        await this._initializeServer(serverId, options);
        this._sendNotificationToStdio(serverId, 'notifications/initialized', {});
    }

    async _startStreamableHttp(serverId, entry, options = {}) {
        const { config } = entry;
        if (!config.url) throw new Error(`Server "${serverId}" (streamable-http) requires "url"`);
        entry.status = 'running';
        await this._initializeServer(serverId, options);
    }

    async _initializeServer(serverId, options = {}) {
        const entry = this.servers.get(serverId);
        const timeout = entry.config.initializeTimeout || DEFAULT_TIMEOUT;

        try {
            const result = await this.sendRequest(serverId, 'initialize', {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {}, resources: {} },
                clientInfo: { name: 'mcp-gateway', version: '1.1.0' },
            }, timeout, options);
            entry.capabilities = result.capabilities || {};
            console.log(`[manager] Server "${serverId}" initialized. Type: ${entry.config.type}`);
        } catch (err) {
            entry.status = 'error';
            throw new Error(`Failed to initialize server "${serverId}": ${err.message}`);
        }
    }

    _sendRequestToStdio(serverId, method, params, timeout = DEFAULT_TIMEOUT) {
        const entry = this.servers.get(serverId);
        const id = uuidv4();
        const message = { jsonrpc: '2.0', id, method, params };

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                entry.pending.delete(id);
                reject(new Error(`Request "${method}" to "${serverId}" timed out`));
            }, timeout);

            entry.pending.set(id, { resolve, reject, timeout: timer });
            entry.process.stdin.write(JSON.stringify(message) + '\n');
        });
    }

    async _sendRequestToHttp(serverId, method, params, timeout = DEFAULT_TIMEOUT, options = {}) {
        const entry = this.servers.get(serverId);
        const id = uuidv4();
        const body = { jsonrpc: '2.0', id, method, params };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        const passthrough = this._sanitizePassthroughHeaders(options.passthroughAuthHeaders);

        try {
            const response = await fetch(entry.config.url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream',
                    ...this._buildAuthHeaders(entry.config),
                    ...passthrough,
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
            }

            const contentType = String(response.headers.get('content-type') || '').toLowerCase();
            const payload = contentType.includes('text/event-stream')
                ? await this._readJsonRpcFromSse(response, id)
                : await response.json();
            if (!payload || payload.jsonrpc !== '2.0') {
                throw new Error('Invalid JSON-RPC response from remote server');
            }
            if (payload.error) {
                throw new Error(`MCP error ${payload.error.code}: ${payload.error.message}`);
            }
            return payload.result;
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error(`Request "${method}" to "${serverId}" timed out`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    _buildAuthHeaders(config) {
        const headers = { ...(config.auth?.headers || {}) };
        const envHeaders = config.auth?.envHeaders || {};
        for (const [headerName, envName] of Object.entries(envHeaders)) {
            if (!envName) continue;
            const value = process.env[envName];
            if (value) headers[headerName] = value;
        }
        return headers;
    }

    _sanitizePassthroughHeaders(headers) {
        if (!headers || typeof headers !== 'object') return {};
        const allowed = new Set(PASSTHROUGH_ALLOWED_HEADERS);
        const sanitized = {};
        for (const [rawName, rawValue] of Object.entries(headers)) {
            const originalName = String(rawName || '').trim().toLowerCase();
            let name = originalName;
            // Be tolerant to common API key header aliases from UI/config.
            if (name === 'apikey' || name === 'x-apikey') {
                name = 'x-api-key';
            }
            if (!name || (!allowed.has(name) && !allowed.has(originalName))) continue;
            if (rawValue === undefined || rawValue === null) continue;
            sanitized[name] = String(rawValue);
        }
        return sanitized;
    }

    async _readJsonRpcFromSse(response, requestId) {
        const text = await response.text();
        const events = text.split('\n\n');

        for (const eventBlock of events) {
            const lines = eventBlock.split('\n');
            const dataLines = lines
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .filter(Boolean);

            if (dataLines.length === 0) continue;
            const dataText = dataLines.join('\n');
            if (dataText === '[DONE]') continue;

            try {
                const parsed = JSON.parse(dataText);
                if (!parsed || parsed.jsonrpc !== '2.0') continue;
                if (parsed.id !== undefined && parsed.id !== null && String(parsed.id) !== String(requestId)) {
                    continue;
                }
                return parsed;
            } catch (_err) {
                // ignore non-JSON data frames
            }
        }

        throw new Error(`Invalid SSE JSON-RPC response: ${text.slice(0, 300)}`);
    }

    _sendNotificationToStdio(serverId, method, params) {
        const entry = this.servers.get(serverId);
        if (!entry || !entry.process) return;
        entry.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    }

    _handleResponse(serverId, msg) {
        const entry = this.servers.get(serverId);
        if (!entry) return;
        if (msg.id === undefined || msg.id === null) return;

        const pending = entry.pending.get(msg.id);
        if (!pending) return;

        clearTimeout(pending.timeout);
        entry.pending.delete(msg.id);

        if (msg.error) {
            pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        } else {
            pending.resolve(msg.result);
        }
    }
}

module.exports = MCPServerManager;
