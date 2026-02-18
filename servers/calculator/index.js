'use strict';

/**
 * Calculator MCP Server
 * A simple stdio-based MCP server providing basic math operations.
 * Communicates via newline-delimited JSON-RPC on stdin/stdout.
 */

const TOOLS = [
    {
        name: 'add',
        description: 'Add two numbers',
        inputSchema: {
            type: 'object',
            properties: {
                a: { type: 'number', description: 'First number' },
                b: { type: 'number', description: 'Second number' },
            },
            required: ['a', 'b'],
        },
    },
    {
        name: 'subtract',
        description: 'Subtract b from a',
        inputSchema: {
            type: 'object',
            properties: {
                a: { type: 'number', description: 'First number' },
                b: { type: 'number', description: 'Second number' },
            },
            required: ['a', 'b'],
        },
    },
    {
        name: 'multiply',
        description: 'Multiply two numbers',
        inputSchema: {
            type: 'object',
            properties: {
                a: { type: 'number', description: 'First number' },
                b: { type: 'number', description: 'Second number' },
            },
            required: ['a', 'b'],
        },
    },
    {
        name: 'divide',
        description: 'Divide a by b',
        inputSchema: {
            type: 'object',
            properties: {
                a: { type: 'number', description: 'Numerator' },
                b: { type: 'number', description: 'Denominator (must not be zero)' },
            },
            required: ['a', 'b'],
        },
    },
];

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
                serverInfo: { name: 'calculator', version: '1.0.0' },
            });
            break;

        case 'tools/list':
            respond(id, { tools: TOOLS });
            break;

        case 'tools/call': {
            const { name, arguments: args } = params;
            const { a, b } = args;

            if (typeof a !== 'number' || typeof b !== 'number') {
                respondError(id, -32602, 'Arguments "a" and "b" must be numbers');
                return;
            }

            let result;
            switch (name) {
                case 'add': result = a + b; break;
                case 'subtract': result = a - b; break;
                case 'multiply': result = a * b; break;
                case 'divide':
                    if (b === 0) { respondError(id, -32602, 'Division by zero'); return; }
                    result = a / b;
                    break;
                default:
                    respondError(id, -32601, `Unknown tool: ${name}`);
                    return;
            }

            respond(id, {
                content: [{ type: 'text', text: String(result) }],
            });
            break;
        }

        // Ignore notifications (no id)
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
            process.stderr.write(`[calculator] Parse error: ${e.message}\n`);
        }
    }
});

process.stdin.on('end', () => process.exit(0));
process.stderr.write('[calculator] MCP server started\n');
