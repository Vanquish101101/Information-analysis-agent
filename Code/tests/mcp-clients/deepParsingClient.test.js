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
