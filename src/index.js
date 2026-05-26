'use strict';

const config = require('./config');
const { app, loadConfig } = require('./app');

const PORT = config.port;

loadConfig()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[gateway] MCP Gateway running on http://localhost:${PORT}`);
      console.log(`[gateway] JSON-RPC endpoint: http://localhost:${PORT}/mcp`);
    });
  })
  .catch((err) => {
    console.error('[gateway] Failed to start:', err);
    process.exit(1);
  });
