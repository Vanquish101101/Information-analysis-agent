// src/mcp-server/http.js
import http from 'node:http';
import { Readable } from 'node:stream';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from './server.js';

// Тот же обход, что уже применён у Агента 2 (Deep parsing agent/Code/src/
// mcp-server/http.js): WebStandardStreamableHTTPServerTransport (Request/
// Response) напрямую, а не Node-обёртка StreamableHTTPServerTransport из
// того же SDK — та тянет @hono/node-server, который на Node v24 ломается
// на пустых 202-ответах (MCP-уведомления без тела).
function toWebRequest(req, port) {
  const url = `http://${req.headers.host ?? `localhost:${port}`}${req.url}`;
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method,
    headers: new Headers(Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]))),
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? 'half' : undefined
  });
}

async function writeWebResponse(webRes, res) {
  res.writeHead(webRes.status, Object.fromEntries(webRes.headers));
  if (!webRes.body) {
    res.end();
    return;
  }
  await new Promise((resolve, reject) => {
    Readable.fromWeb(webRes.body).pipe(res).on('finish', resolve).on('error', reject);
  });
}

export function createMcpHttpServer({ db, port }) {
  return http.createServer(async (req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'information-analysis-agent' }));
      return;
    }

    if (req.url === '/mcp') {
      try {
        // Stateless-режим (sessionIdGenerator: undefined) — инструменты
        // read-only и не зависят от состояния HTTP-сессии, всё состояние в
        // Supabase. SDK в этом режиме требует НОВЫЙ Server+transport на
        // каждый запрос, поэтому createMcpServer() вызывается здесь, а не
        // один раз на весь процесс.
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        transport.onerror = (err) => console.error('[mcp transport error]', err.stack ?? err);
        await createMcpServer({ db }).connect(transport);
        const webRes = await transport.handleRequest(toWebRequest(req, port));
        await writeWebResponse(webRes, res);
      } catch (err) {
        console.error('[mcp http] request failed:', err.stack ?? err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
}
