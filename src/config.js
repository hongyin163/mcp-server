'use strict';

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

function parseList(value, fallback = []) {
  if (!value) return fallback;
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const config = {
  port: Number(process.env.PORT || 3002),
  mcpAdminToken: process.env.MCP_ADMIN_TOKEN || '',
  allowedOrigins: parseList(process.env.ALLOWED_ORIGINS),
  passthroughAuthHeaders: parseList(process.env.MCP_PASSTHROUGH_AUTH_HEADERS, ['authorization', 'x-api-key', 'apikey'])
    .map((h) => h.toLowerCase()),
};

module.exports = config;
