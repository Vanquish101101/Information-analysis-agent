// src/mcp-server/server.js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getDigest, getClaimDetail, getStatus } from './queries.js';

export async function listTools() {
  return {
    tools: [
      {
        name: 'analysis_digest',
        description: 'Краткий дайджест последнего (или указанного) прогона анализа: факты, противоречия, количественные агрегаты.',
        inputSchema: {
          type: 'object',
          properties: {
            run_id: { type: 'string', description: 'Опционально: id конкретного прогона. По умолчанию — последний.' }
          }
        }
      },
      {
        name: 'analysis_detail',
        description: 'Полный разбор конкретного факта: источники, обоснование.',
        inputSchema: {
          type: 'object',
          properties: {
            claim_id: { type: 'string', description: 'id факта (claim), полученный из detail_ref в analysis_digest.' }
          },
          required: ['claim_id']
        }
      },
      {
        name: 'analysis_status',
        description: 'Текущее состояние последнего прогона и неразрешённые эскалации, ожидающие решения пользователя.',
        inputSchema: { type: 'object', properties: {} }
      }
    ]
  };
}

export async function callTool(db, request) {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'analysis_digest') {
      const digest = await getDigest(db, args?.run_id ?? null);
      return { content: [{ type: 'text', text: JSON.stringify(digest, null, 2) }] };
    }

    if (name === 'analysis_detail') {
      if (!args?.claim_id) {
        return { content: [{ type: 'text', text: 'analysis_detail: claim_id is required' }], isError: true };
      }
      const detail = await getClaimDetail(db, args.claim_id);
      if (!detail) {
        return { content: [{ type: 'text', text: `analysis_detail: claim ${args.claim_id} not found` }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }] };
    }

    if (name === 'analysis_status') {
      const status = await getStatus(db);
      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  } catch (error) {
    return { content: [{ type: 'text', text: `Ошибка: ${error.message}` }], isError: true };
  }
}

export function createMcpServer({ db }) {
  const server = new Server(
    { name: 'information-analysis-agent', version: '0.5.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, listTools);
  server.setRequestHandler(CallToolRequestSchema, (request) => callTool(db, request));

  return server;
}
