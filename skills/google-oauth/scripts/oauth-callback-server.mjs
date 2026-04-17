#!/usr/bin/env node
/**
 * Minimal OAuth2 callback server.
 * Starts HTTP server, waits for Google OAuth redirect with ?code=...,
 * writes code to a file, and exits.
 *
 * Usage: node oauth-callback-server.mjs <port> <output-file> [timeout-seconds]
 */

import http from 'node:http';
import fs from 'node:fs';
import url from 'node:url';

const port = parseInt(process.argv[2] || '3200', 10);
const outputFile = process.argv[3] || '/tmp/google-oauth-code.txt';
const timeoutSec = parseInt(process.argv[4] || '300', 10);

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/callback') {
    const code = parsed.query.code;
    const error = parsed.query.error;

    if (error) {
      fs.writeFileSync(outputFile, JSON.stringify({ error, description: parsed.query.error_description || '' }));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2>Authorization failed</h2><p>${error}: ${parsed.query.error_description || ''}</p><p>You can close this tab.</p>`);
      setTimeout(() => process.exit(1), 500);
      return;
    }

    if (code) {
      fs.writeFileSync(outputFile, JSON.stringify({ code }));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>Authorization successful!</h2><p>You can close this tab. Kuro is handling the rest.</p>');
      console.log(`[oauth-callback] Code received, written to ${outputFile}`);
      setTimeout(() => process.exit(0), 500);
      return;
    }
  }

  // Health check / status
  if (parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'waiting', port, outputFile }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(port, () => {
  console.log(`[oauth-callback] Listening on http://localhost:${port}/callback`);
  console.log(`[oauth-callback] Will write auth code to: ${outputFile}`);
  console.log(`[oauth-callback] Timeout: ${timeoutSec}s`);
});

// Auto-exit on timeout
const timer = setTimeout(() => {
  console.error(`[oauth-callback] Timeout after ${timeoutSec}s — no callback received`);
  fs.writeFileSync(outputFile, JSON.stringify({ error: 'timeout', description: `No callback received within ${timeoutSec}s` }));
  process.exit(2);
}, timeoutSec * 1000);

// Cleanup on signals
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearTimeout(timer);
    server.close();
    process.exit(0);
  });
}
