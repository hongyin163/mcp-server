'use strict';

/**
 * MessageRouter
 * Routes incoming WebSocket messages to the correct MCP server managed by MCPServerManager.
 *
 * Message format from client:
 * {
 *   serverId: string,       // which MCP server to call
 *   jsonrpc: "2.0",
 *   id: string|number,
 *   method: string,         // e.g. "tools/list", "tools/call"
 *   params: object
 * }
 *
 * The router strips `serverId` before forwarding to the server,
 * then wraps the response with the original `serverId` for the client.
 */
class MessageRouter {
    /**
     * @param {import('./manager')} manager
     */
    constructor(manager) {
        this.manager = manager;
    }

    /**
     * Route a client message to the appropriate MCP server.
     * @param {object} message - parsed JSON from WebSocket client
     * @returns {Promise<object>} JSON-RPC response to send back
     */
    async route(message) {
        const { serverId, id, method, params } = message;

        // Special: list all available servers
        if (method === 'gateway/list_servers') {
            return {
                jsonrpc: '2.0',
                id,
                result: { servers: this.manager.listServers() },
            };
        }

        // Special: start a server on demand
        if (method === 'gateway/start_server') {
            const { serverId: targetId } = params || {};
            try {
                await this.manager.start(targetId);
                return { jsonrpc: '2.0', id, result: { ok: true } };
            } catch (err) {
                return this._error(id, -32000, err.message);
            }
        }

        // All other methods: forward to the target MCP server
        if (!serverId) {
            return this._error(id, -32600, 'Missing "serverId" in request');
        }

        try {
            const result = await this.manager.sendRequest(serverId, method, params);
            return { jsonrpc: '2.0', id, result };
        } catch (err) {
            return this._error(id, -32000, err.message);
        }
    }

    _error(id, code, message) {
        return { jsonrpc: '2.0', id, error: { code, message } };
    }
}

module.exports = MessageRouter;
