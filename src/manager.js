'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

/**
 * MCPServerManager
 * Manages stdio-based MCP server subprocesses.
 * Each managed server is started as a child process and communicates via JSON-RPC over stdin/stdout.
 */
class MCPServerManager {
    constructor() {
        /** @type {Map<string, ManagedServer>} */
        this.servers = new Map();
    }

    /**
     * Register a server config (does not start it yet unless autoStart=true).
     * @param {object} config
     */
    async register(config) {
        const entry = {
            config,
            process: null,
            status: 'stopped',
            capabilities: null,
            /** @type {Map<string|number, PendingRequest>} */
            pending: new Map(),
            buffer: '',
        };
        this.servers.set(config.id, entry);

        if (config.autoStart) {
            await this.start(config.id);
        }
    }

    /**
     * Start a stdio MCP server subprocess.
     * @param {string} serverId
     */
    async start(serverId) {
        const entry = this.servers.get(serverId);
        if (!entry) throw new Error(`Server "${serverId}" not registered`);
        if (entry.status === 'running') return;

        const { config } = entry;
        const cwd = path.resolve(__dirname, '..');

        console.log(`[manager] Starting server "${serverId}": ${config.command} ${config.args.join(' ')}`);

        const proc = spawn(config.command, config.args, {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        proc.stderr.on('data', (data) => {
            console.error(`[${serverId}] stderr: ${data.toString().trim()}`);
        });

        proc.stdout.on('data', (data) => {
            entry.buffer += data.toString();
            // Messages are newline-delimited JSON
            const lines = entry.buffer.split('\n');
            entry.buffer = lines.pop(); // keep incomplete last line
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const msg = JSON.parse(trimmed);
                    this._handleResponse(serverId, msg);
                } catch (e) {
                    console.error(`[${serverId}] Failed to parse message: ${trimmed}`);
                }
            }
        });

        proc.on('exit', (code) => {
            console.log(`[manager] Server "${serverId}" exited with code ${code}`);
            entry.status = 'stopped';
            entry.process = null;
            // Reject all pending requests
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

        // MCP handshake: initialize
        try {
            const result = await this._sendRequest(serverId, 'initialize', {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {}, resources: {} },
                clientInfo: { name: 'mcp-gateway', version: '1.0.0' },
            });
            entry.capabilities = result.capabilities || {};
            console.log(`[manager] Server "${serverId}" initialized. Capabilities:`, entry.capabilities);

            // Send initialized notification
            this._sendNotification(serverId, 'notifications/initialized', {});
        } catch (err) {
            console.error(`[manager] Failed to initialize server "${serverId}": ${err.message}`);
            entry.status = 'error';
        }
    }

    /**
     * Stop a running server.
     * @param {string} serverId
     */
    stop(serverId) {
        const entry = this.servers.get(serverId);
        if (!entry || !entry.process) return;
        entry.process.kill();
        entry.status = 'stopped';
        entry.process = null;
    }

    /**
     * Send a JSON-RPC request to a server and return the result.
     * @param {string} serverId
     * @param {string} method
     * @param {object} params
     * @param {number} [timeout=30000]
     * @returns {Promise<any>}
     */
    async sendRequest(serverId, method, params, timeout = 30000) {
        const entry = this.servers.get(serverId);
        if (!entry) throw new Error(`Server "${serverId}" not registered`);
        if (entry.status !== 'running') {
            // Try to start on demand
            await this.start(serverId);
        }
        return this._sendRequest(serverId, method, params, timeout);
    }

    /**
     * List all registered servers with their status and capabilities.
     */
    listServers() {
        return Array.from(this.servers.values()).map(({ config, status, capabilities }) => ({
            id: config.id,
            name: config.name,
            description: config.description,
            status,
            capabilities,
            enabled: config.enabled,
        }));
    }

    // ─── Private ───────────────────────────────────────────────────────────────

    _sendRequest(serverId, method, params, timeout = 30000) {
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

    _sendNotification(serverId, method, params) {
        const entry = this.servers.get(serverId);
        if (!entry || !entry.process) return;
        const message = { jsonrpc: '2.0', method, params };
        entry.process.stdin.write(JSON.stringify(message) + '\n');
    }

    _handleResponse(serverId, msg) {
        const entry = this.servers.get(serverId);
        if (!entry) return;

        // Notification (no id) — ignore for now
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
