import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Клиент к MCP-серверу Агента 2 (Deep Parsing Agent) — используется узлом
// escalation для автоповтора низкоуверенных item'ов через deepparsing_parse
// с mode: 'deep'. ClientImpl/TransportImpl инжектируются для тестов (по
// умолчанию — реальные классы из @modelcontextprotocol/sdk, той же версии,
// что уже используется Агентом 1/2).
export function createDeepParsingClient({ baseUrl, ClientImpl = Client, TransportImpl = StreamableHTTPClientTransport } = {}) {
  if (!baseUrl) {
    throw new Error('createDeepParsingClient: baseUrl is required');
  }

  return async function retryParse({ contentRef, contentType }) {
    const transport = new TransportImpl(new URL(`${baseUrl}/mcp`));
    const client = new ClientImpl(
      { name: 'information-analysis-agent', version: '0.5.0' },
      { capabilities: {} }
    );

    await client.connect(transport);
    try {
      const response = await client.callTool({
        name: 'deepparsing_parse',
        arguments: { content_ref: contentRef, content_type: contentType, mode: 'deep' }
      });

      const text = response.content?.[0]?.text;
      if (!text) {
        throw new Error('deepParsingClient: empty response from deepparsing_parse');
      }
      return JSON.parse(text);
    } finally {
      await client.close();
    }
  };
}
