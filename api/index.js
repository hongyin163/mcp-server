'use strict';

const { app, loadConfig } = require('../src/app');
const config = require('../src/config');

const startup = config.disableAutoRegister
  ? Promise.resolve()
  : loadConfig().catch((err) => {
      console.error('[gateway] Vercel loadConfig failed:', err);
    });

module.exports = async (req, res) => {
  await startup;
  return app(req, res);
};
