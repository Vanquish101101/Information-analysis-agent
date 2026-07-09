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

test('builds the request with the correct URL, model, both texts in the prompt, and usage:{include:true}', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"is_duplicate": false, "reasoning": "разные"}' } }], usage: { cost: 0.00001 } });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'secret-key', fetchImpl });

  await judgeDuplicate({ kind: 'entity', new: 'Продукт X', candidate: 'Продукт Y' });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(options.headers['Authorization'], 'Bearer secret-key');
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'anthropic/claude-haiku-4-5');
  assert.deepEqual(body.usage, { include: true });
  assert.match(body.messages[0].content, /Продукт X/);
  assert.match(body.messages[0].content, /Продукт Y/);
});

test('routes through Helicone proxy and adds Helicone-Auth header when heliconeApiKey is set', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"is_duplicate": false, "reasoning": "ok"}' } }], usage: { cost: 0.00001 } });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'secret-key', heliconeApiKey: 'helicone-key', fetchImpl });

  await judgeDuplicate({ kind: 'entity', new: 'X', candidate: 'Y' });

  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.helicone.ai/api/v1/chat/completions');
  assert.equal(options.headers['Helicone-Auth'], 'Bearer helicone-key');
});

test('parses a positive verdict', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"is_duplicate": true, "reasoning": "то же самое"}' } }], usage: { cost: 0.00002 } });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeDuplicate({ kind: 'claim', new: 'A: B: C', candidate: 'A: B: C (иначе)' });

  assert.equal(result.isDuplicate, true);
  assert.equal(result.reasoning, 'то же самое');
});

test('parses a negative verdict', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"is_duplicate": false, "reasoning": "разное"}' } }], usage: { cost: 0.00002 } });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeDuplicate({ kind: 'entity', new: 'X', candidate: 'Y' });

  assert.equal(result.isDuplicate, false);
});

test('returns the real cost from usage.cost', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"is_duplicate": false, "reasoning": "ok"}' } }], usage: { cost: 0.000015 } });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeDuplicate({ kind: 'entity', new: 'X', candidate: 'Y' });

  assert.equal(result.costUsd, 0.000015);
});

test('defaults costUsd to 0 when the response has no usage.cost field', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"is_duplicate": false, "reasoning": "ok"}' } }] });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeDuplicate({ kind: 'entity', new: 'X', candidate: 'Y' });

  assert.equal(result.costUsd, 0);
});

test('strips a ```json code fence before parsing', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '```json\n{"is_duplicate": true, "reasoning": "ok"}\n```' } }], usage: { cost: 0.00001 } });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeDuplicate({ kind: 'entity', new: 'X', candidate: 'X' });

  assert.equal(result.isDuplicate, true);
});

test('throws a descriptive error when the LLM response is not valid JSON', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: 'не JSON' } }] });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => judgeDuplicate({ kind: 'entity', new: 'X', candidate: 'Y' }), /invalid JSON/);
});

test('attaches the real already-incurred costUsd to the thrown error when parsing fails after a successful paid HTTP call', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: 'не JSON' } }], usage: { cost: 0.00003 } });
  const judgeDuplicate = createDuplicateJudge({ apiKey: 'test-key', fetchImpl });

  try {
    await judgeDuplicate({ kind: 'entity', new: 'X', candidate: 'Y' });
    assert.fail('expected judgeDuplicate to throw');
  } catch (err) {
    assert.equal(err.costUsd, 0.00003);
  }
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
