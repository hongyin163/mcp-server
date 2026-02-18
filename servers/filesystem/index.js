'use strict';

/**
 * Filesystem MCP Server
 * A stdio-based MCP server providing safe read-only file operations.
 * Only allows access within the configured BASE_DIR for security.
 */

const fs = require('fs');
const path = require('path');

// Restrict all file access to this directory (configurable via env)
const BASE_DIR = process.env.MCP_FS_BASE_DIR
    ? path.resolve(process.env.MCP_FS_BASE_DIR)
    : path.resolve(__dirname, '../../workspace');

// Ensure workspace directory exists
if (!fs.existsSync(BASE_DIR)) {
    fs.mkdirSync(BASE_DIR, { recursive: true });
}

const TOOLS = [
    {
        name: 'read_file',
        description: 'Read the contents of a file (relative to the workspace directory)',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative file path within the workspace' },
            },
            required: ['path'],
        },
    },
    {
        name: 'list_directory',
        description: 'List files and folders in a directory (relative to the workspace)',
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Relative directory path (use "." for workspace root)',
                    default: '.',
                },
            },
            required: [],
        },
    },
    {
        name: 'write_file',
        description: 'Write content to a file in the workspace (creates file if not exists)',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative file path within the workspace' },
                content: { type: 'string', description: 'Content to write' },
            },
            required: ['path', 'content'],
        },
    },
];

/**
 * Resolve and validate a path is within BASE_DIR.
 * Throws if the path escapes the workspace.
 */
function safePath(relativePath) {
    const resolved = path.resolve(BASE_DIR, relativePath);
    if (!resolved.startsWith(BASE_DIR)) {
        throw new Error('Access denied: path is outside the workspace directory');
    }
    return resolved;
}

function respond(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, code, message) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function handleMessage(msg) {
    const { id, method, params } = msg;

    switch (method) {
        case 'initialize':
            respond(id, {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'filesystem', version: '1.0.0' },
            });
            break;

        case 'tools/list':
            respond(id, { tools: TOOLS });
            break;

        case 'tools/call': {
            const { name, arguments: args } = params;

            try {
                if (name === 'read_file') {
                    const filePath = safePath(args.path);
                    if (!fs.existsSync(filePath)) {
                        respondError(id, -32602, `File not found: ${args.path}`);
                        return;
                    }
                    const content = fs.readFileSync(filePath, 'utf8');
                    respond(id, { content: [{ type: 'text', text: content }] });

                } else if (name === 'list_directory') {
                    const dirPath = safePath(args.path || '.');
                    if (!fs.existsSync(dirPath)) {
                        respondError(id, -32602, `Directory not found: ${args.path}`);
                        return;
                    }
                    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
                    const list = entries.map((e) => ({
                        name: e.name,
                        type: e.isDirectory() ? 'directory' : 'file',
                    }));
                    respond(id, {
                        content: [{ type: 'text', text: JSON.stringify(list, null, 2) }],
                    });

                } else if (name === 'write_file') {
                    const filePath = safePath(args.path);
                    fs.mkdirSync(path.dirname(filePath), { recursive: true });
                    fs.writeFileSync(filePath, args.content, 'utf8');
                    respond(id, { content: [{ type: 'text', text: `File written: ${args.path}` }] });

                } else {
                    respondError(id, -32601, `Unknown tool: ${name}`);
                }
            } catch (err) {
                respondError(id, -32000, err.message);
            }
            break;
        }

        default:
            if (id !== undefined) {
                respondError(id, -32601, `Method not found: ${method}`);
            }
    }
}

// ─── stdin reader ─────────────────────────────────────────────────────────────
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            handleMessage(JSON.parse(trimmed));
        } catch (e) {
            process.stderr.write(`[filesystem] Parse error: ${e.message}\n`);
        }
    }
});

process.stdin.on('end', () => process.exit(0));
process.stderr.write(`[filesystem] MCP server started. Workspace: ${BASE_DIR}\n`);
