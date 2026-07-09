import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeepParsingClient } from '../../src/mcp-clients/deepParsingClient.js';

function fakeClientClasses(responsePayload, { callToolThrows = null } = {}) {
  const calls = { connect: [], callTool: [], close: 0 };

  class FakeTransport {
    constructor(url) {
      calls.transportUrl = url;
    }
  }

  class FakeClient {
    constructor(info, options) {
      calls.clientInfo = info;
      calls.clientOptions = options;
    }
    async connect(transport) {
      calls.connect.push(transport);
    }
    async callTool(args) {
      calls.callTool.push(args);
      if (callToolThrows) throw callToolThrows;
      return { content: [{ type: 'text', text: JSON.stringify(responsePayload) }] };
    }
    async close() {
      calls.close += 1;
    }
  }

  return { ClientImpl: FakeClient, TransportImpl: FakeTransport, calls };
}

test('throws when baseUrl is missing', () => {
  assert.throws(() => createDeepParsingClient({}), /baseUrl is required/);
});

test('connects to baseUrl + /mcp and calls deepparsing_parse with mode: deep', async () => {
  const { ClientImpl, TransportImpl, calls } = fakeClientClasses({
    result: { transcript: 'улучшенный разбор' },
    confidence: { level: 'высокая', explanation: 'deep mode' },
    meta: { cost_usd: 0.08 }
  });
  const retryParse = createDeepParsingClient({ baseUrl: 'http://deep-parsing-agent:7301', ClientImpl, TransportImpl });

  await retryParse({ contentRef: 'https://example.com/video.mp4', contentType: 'video' });

  assert.equal(calls.transportUrl.toString(), 'http://deep-parsing-agent:7301/mcp');
  assert.equal(calls.callTool.length, 1);
  assert.deepEqual(calls.callTool[0], {
    name: 'deepparsing_parse',
    arguments: { content_ref: 'https://example.com/video.mp4', content_type: 'video', mode: 'deep' }
  });
});

test('returns the parsed JSON result on success, and closes the client', async () => {
  const { ClientImpl, TransportImpl, calls } = fakeClientClasses({
    result: { transcript: 'улучшенный разбор' },
    confidence: { level: 'высокая', explanation: 'deep mode' },
    meta: { cost_usd: 0.08 }
  });
  const retryParse = createDeepParsingClient({ baseUrl: 'http://deep-parsing-agent:7301', ClientImpl, TransportImpl });

  const result = await retryParse({ contentRef: 'https://example.com/video.mp4', contentType: 'video' });

  assert.deepEqual(result.result, { transcript: 'улучшенный разбор' });
  assert.equal(result.confidence.level, 'высокая');
  assert.equal(result.meta.cost_usd, 0.08);
  assert.equal(calls.close, 1);
});

test('throws a descriptive error when the tool call rejects', async () => {
  const { ClientImpl, TransportImpl } = fakeClientClasses(null, { callToolThrows: new Error('connection refused') });
  const retryParse = createDeepParsingClient({ baseUrl: 'http://deep-parsing-agent:7301', ClientImpl, TransportImpl });

  await assert.rejects(
    () => retryParse({ contentRef: 'x', contentType: 'video' }),
    /connection refused/
  );
});

test('throws a descriptive error when the response has no text content', async () => {
  class FakeTransport { constructor() {} }
  class FakeClient {
    async connect() {}
    async callTool() { return { content: [] }; }
    async close() {}
  }
  const retryParse = createDeepParsingClient({ baseUrl: 'http://deep-parsing-agent:7301', ClientImpl: FakeClient, TransportImpl: FakeTransport });

  await assert.rejects(
    () => retryParse({ contentRef: 'x', contentType: 'video' }),
    /empty response/
  );
});

test('throws a descriptive error when Agent 2 queues the job instead of returning a synchronous result (mode: deep is always a heavy task)', async () => {
  const { ClientImpl, TransportImpl, calls } = fakeClientClasses({ status: 'queued', job_id: 'job-async-1' });
  const retryParse = createDeepParsingClient({ baseUrl: 'http://deep-parsing-agent:7301', ClientImpl, TransportImpl });

  await assert.rejects(
    () => retryParse({ contentRef: 'https://example.com/video.mp4', contentType: 'video' }),
    /queued|async/
  );
  assert.equal(calls.close, 1, 'client is still closed even when the response is rejected as queued');
});

test('throws a descriptive error when the response is missing result or confidence (not the expected synchronous shape)', async () => {
  const { ClientImpl, TransportImpl } = fakeClientClasses({ result: { transcript: 'x' } }); // no confidence field
  const retryParse = createDeepParsingClient({ baseUrl: 'http://deep-parsing-agent:7301', ClientImpl, TransportImpl });

  await assert.rejects(
    () => retryParse({ contentRef: 'x', contentType: 'video' }),
    /queued|async/
  );
});

test('closes the client even when connect() itself throws', async () => {
  const calls = { close: 0 };
  class FakeTransport { constructor() {} }
  class FakeClient {
    async connect() { throw new Error('connection refused'); }
    async callTool() { throw new Error('should not be called'); }
    async close() { calls.close += 1; }
  }
  const retryParse = createDeepParsingClient({ baseUrl: 'http://deep-parsing-agent:7301', ClientImpl: FakeClient, TransportImpl: FakeTransport });

  await assert.rejects(() => retryParse({ contentRef: 'x', contentType: 'video' }), /connection refused/);
  assert.equal(calls.close, 1);
});
