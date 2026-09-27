#!/usr/bin/env node
import { createServer as createHttpServer } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getConfig } from './config.js';
import { getAppContext } from './server/context.js';
import { createMcpServer, SERVER_VERSION } from './server/mcpServer.js';
import { GODCPError } from './utils/errors.js';

async function main(): Promise<void> {
  const config = getConfig();
  const ctx = getAppContext(config);
  const server = createMcpServer();

  ctx.logger.info(`GODCP-mcp v${SERVER_VERSION} starting`, {
    transport: config.transport,
    vision: config.vision.provider,
    unity: config.unity.profile,
    meshy: config.meshy.configured ? 'configured' : 'not configured',
    budget: config.budget,
  });

  if (config.transport === 'http') {
    const port = config.httpPort;
    const http = createHttpServer(async (req, res) => {
      if (req.method !== 'POST' || !req.url?.startsWith('/mcp')) {
        res.writeHead(404).end(JSON.stringify({ error: 'Not found. POST /mcp for MCP.' }));
        return;
      }
      try {
        // Stateless: a fresh transport per request (no session persistence).
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        const payload = GODCPError.from(err, 'http_transport').toJSON();
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      }
    });
    http.listen(port, () => ctx.logger.info(`HTTP transport listening on http://127.0.0.1:${port}/mcp`));
    return;
  }

  const stdio = new StdioServerTransport();
  await server.connect(stdio);
  ctx.logger.info('Stdio transport connected.');
}

main().catch((err) => {
  const payload = GODCPError.from(err, 'startup').toJSON();
  // stdout is reserved for MCP — log to stderr
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exit(1);
});
