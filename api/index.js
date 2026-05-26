'use strict';

const serverless = require('serverless-http');
const { app, loadConfig } = require('../src/app');
const config = require('../src/config');

const startup = config.disableAutoRegister
  ? Promise.resolve()
  : loadConfig().catch((err) => {
      console.error('[gateway] Vercel loadConfig failed:', err);
    });

const handler = serverless(app);

module.exports = async (req, res) => {
  await startup;
  return handler(req, res);
};
