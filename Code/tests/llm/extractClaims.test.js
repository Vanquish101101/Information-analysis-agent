import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenRouterExtractor } from '../../src/llm/extractClaims.js';

function fakeFetch(responseBody, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok,
      status,
      json: async () => responseBody
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('throws when apiKey is missing', () => {
  assert.throws(
    () => createOpenRouterExtractor({}),
    /apiKey is required/
  );
});

test('returns [] without calling fetch when item has no result and no fallback text', async () => {
  const fetchImpl = fakeFetch({});
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  const claims = await extractClaims({ job_id: 'job-1', agent: 1, result: null });

  assert.deepEqual(claims, []);
  assert.equal(fetchImpl.calls.length, 0);
});

test('uses telegram_text_fallback when result is null but fallback is present', async () => {
  const fetchImpl = fakeFetch({
    choices: [{ message: { content: '[]' } }]
  });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  const claims = await extractClaims({
    job_id: 'job-2',
    agent: 1,
    result: null,
    telegram_text_fallback: 'только текстовый отчёт'
  });

  assert.deepEqual(claims, []);
  assert.equal(fetchImpl.calls.length, 1);
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.match(body.messages[0].content, /только текстовый отчёт/);
});

test('builds the request with the correct URL, model, and headers', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '[]' } }] });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'secret-key', fetchImpl });

  await extractClaims({ job_id: 'job-3', agent: 1, result: { summary: 'тест' } });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(options.headers['Authorization'], 'Bearer secret-key');
  assert.equal(options.headers['Content-Type'], 'application/json');
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'anthropic/claude-haiku-4-5');
});

test('routes through Helicone proxy and adds Helicone-Auth header when heliconeApiKey is set', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '[]' } }] });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'secret-key', heliconeApiKey: 'helicone-key', fetchImpl });

  await extractClaims({ job_id: 'job-helicone', agent: 1, result: { summary: 'тест' } });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.helicone.ai/api/v1/chat/completions');
  assert.equal(options.headers['Authorization'], 'Bearer secret-key');
  assert.equal(options.headers['Helicone-Auth'], 'Bearer helicone-key');
});

test('parses a valid JSON array response into RawClaim objects', async () => {
  const fetchImpl = fakeFetch({
    choices: [{
      message: {
        content: JSON.stringify([
          {
            subject: 'Продукт X',
            predicate: 'имеет цену',
            object_value: '999 руб',
            confidence_level: 'высокая',
            confidence_explanation: 'Указано явно в источнике'
          }
        ])
      }
    }]
  });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  const claims = await extractClaims({ job_id: 'job-4', agent: 1, result: { summary: 'тест' } });

  assert.equal(claims.length, 1);
  assert.equal(claims[0].subject, 'Продукт X');
  assert.equal(claims[0].confidence_level, 'высокая');
});

test('treats a valid empty JSON array response as zero claims, not an error', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '[]' } }] });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  const claims = await extractClaims({ job_id: 'job-5', agent: 1, result: { summary: 'ничего нет' } });

  assert.deepEqual(claims, []);
});

test('strips a ```json code fence around the response before parsing', async () => {
  const fetchImpl = fakeFetch({
    choices: [{ message: { content: '```json\n[{"subject":"A","predicate":"B","object_value":"C","confidence_level":"средняя","confidence_explanation":"D"}]\n```' } }]
  });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  const claims = await extractClaims({ job_id: 'job-6', agent: 1, result: { summary: 'тест' } });

  assert.equal(claims.length, 1);
  assert.equal(claims[0].subject, 'A');
});

test('throws a descriptive error when the LLM response is not valid JSON', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: 'это не JSON вообще' } }] });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(
    () => extractClaims({ job_id: 'job-7', agent: 1, result: { summary: 'тест' } }),
    /invalid JSON/
  );
});

test('throws a descriptive error when the HTTP response is not ok', async () => {
  const fetchImpl = fakeFetch({}, { ok: false, status: 429 });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(
    () => extractClaims({ job_id: 'job-8', agent: 1, result: { summary: 'тест' } }),
    /HTTP 429/
  );
});

test('throws a descriptive error when a claim has an invalid confidence_level', async () => {
  const fetchImpl = fakeFetch({
    choices: [{
      message: {
        content: JSON.stringify([{ subject: 'A', predicate: 'B', object_value: 'C', confidence_level: 'unknown', confidence_explanation: 'D' }])
      }
    }]
  });
  const extractClaims = createOpenRouterExtractor({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(
    () => extractClaims({ job_id: 'job-9', agent: 1, result: { summary: 'тест' } }),
    /invalid confidence_level/
  );
});
