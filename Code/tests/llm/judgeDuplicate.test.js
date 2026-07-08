import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDuplicateJudge } from '../../src/llm/judgeDuplicate.js';

function fakeFetch(responseBody, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok, status, json: async () => responseBody };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('throws when apiKey is missing', () => {
  assert.throws(() => createDuplicateJudge({}), /apiKey is required/);
});

test('builds the request with the correct URL, model, and both texts in the prompt', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"is_duplicate": false, "reasoning": "разные"}' } }] });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'secret-key', fetchImpl });

  await judgeDuplicate({ kind: 'entity', new: 'Продукт X', candidate: 'Продукт Y' });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(options.headers['Authorization'], 'Bearer secret-key');
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'anthropic/claude-haiku-4-5');
  assert.match(body.messages[0].content, /Продукт X/);
  assert.match(body.messages[0].content, /Продукт Y/);
});

test('parses a positive verdict', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"is_duplicate": true, "reasoning": "то же самое"}' } }] });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeDuplicate({ kind: 'claim', new: 'A: B: C', candidate: 'A: B: C (иначе)' });

  assert.equal(result.isDuplicate, true);
  assert.equal(result.reasoning, 'то же самое');
});

test('parses a negative verdict', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"is_duplicate": false, "reasoning": "разное"}' } }] });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeDuplicate({ kind: 'entity', new: 'X', candidate: 'Y' });

  assert.equal(result.isDuplicate, false);
});

test('strips a ```json code fence before parsing', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '```json\n{"is_duplicate": true, "reasoning": "ok"}\n```' } }] });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeDuplicate({ kind: 'entity', new: 'X', candidate: 'X' });

  assert.equal(result.isDuplicate, true);
});

test('throws a descriptive error when the LLM response is not valid JSON', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: 'не JSON' } }] });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => judgeDuplicate({ kind: 'entity', new: 'X', candidate: 'Y' }), /invalid JSON/);
});

test('throws a descriptive error when the HTTP response is not ok', async () => {
  const fetchImpl = fakeFetch({}, { ok: false, status: 500 });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => judgeDuplicate({ kind: 'entity', new: 'X', candidate: 'Y' }), /HTTP 500/);
});

test('throws a descriptive error when is_duplicate is missing or not boolean', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"reasoning": "no verdict field"}' } }] });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => judgeDuplicate({ kind: 'entity', new: 'X', candidate: 'Y' }), /missing boolean is_duplicate/);
});
