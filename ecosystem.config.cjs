/**
 * PM2 Ecosystem Configuration — agent-middleware
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 restart agent-middleware
 *   pm2 logs agent-middleware
 *   pm2 status
 *
 * Environment variables are read from .env (loaded by dotenv in server.ts),
 * or can be overridden by PM2's env_production block below.
 *
 * Cross-platform: works on macOS / Linux / Windows / WSL identically.
 */
const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'agent-middleware',
      script: './dist/server.js',
      cwd: __dirname,

      // Process management
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',

      // Environment
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3200,
      },

      // Logging
      error_file: path.join(__dirname, 'logs/error.log'),
      out_file: path.join(__dirname, 'logs/out.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      time: true,

      // Restart policy
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 2000,

      // Graceful shutdown
      kill_timeout: 5000,
      listen_timeout: 10000,
    },
  ],
};
