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

    try {
      await client.connect(transport);
      const response = await client.callTool({
        name: 'deepparsing_parse',
        arguments: { content_ref: contentRef, content_type: contentType, mode: 'deep' }
      });

      const text = response.content?.[0]?.text;
      if (!text) {
        throw new Error('deepParsingClient: empty response from deepparsing_parse');
      }
      const parsed = JSON.parse(text);

      // Агент 2 всегда обрабатывает mode: 'deep' как тяжёлую задачу
      // (isHeavyTask возвращает true безусловно для mode === 'deep' —
      // проверено чтением его queue/index.js) и, если результата нет в кэше,
      // ставит её в очередь асинхронно вместо синхронного ответа: тогда
      // deepparsing_parse возвращает {status: 'queued', job_id}, а не
      // {result, confidence, meta}. Синхронное ожидание/поллинг
      // deepparsing_status здесь пока не реализованы — до этого момента
      // такой ответ должен считаться неудачным повтором (эскалация в
      // pending_user_decisions с исходными данными item'а), а не тихо
      // приниматься как успех с result/confidence === undefined.
      if (parsed.status === 'queued' || !parsed.result || !parsed.confidence) {
        throw new Error(`deepParsingClient: retry did not complete synchronously (Agent 2 queued it for async processing instead of returning a result immediately, job_id: ${parsed.job_id ?? 'unknown'}) — synchronous auto-retry is not yet supported for queued jobs`);
      }

      return parsed;
    } finally {
      await client.close();
    }
  };
}
