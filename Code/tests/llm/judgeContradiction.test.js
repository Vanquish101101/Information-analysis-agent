import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContradictionJudge } from '../../src/llm/judgeContradiction.js';

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
  assert.throws(() => createContradictionJudge({}), /apiKey is required/);
});

test('builds the request with the correct URL, model, and both claim texts in the prompt', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"label": "agree", "confidence_level": "средняя", "explanation": "ok"}' } }] });
  const judgeContradiction = createContradictionJudge({ apiKey: 'secret-key', fetchImpl });

  await judgeContradiction({ newClaimText: 'X: подняла: 5 млн', existingClaimText: 'подняла: 3 млн' });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(options.headers['Authorization'], 'Bearer secret-key');
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'anthropic/claude-haiku-4-5');
  assert.match(body.messages[0].content, /5 млн/);
  assert.match(body.messages[0].content, /3 млн/);
});

test('routes through Helicone proxy and adds Helicone-Auth header when heliconeApiKey is set', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"label": "agree", "confidence_level": "средняя", "explanation": "ok"}' } }] });
  const judgeContradiction = createContradictionJudge({ apiKey: 'secret-key', heliconeApiKey: 'helicone-key', fetchImpl });

  await judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' });

  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.helicone.ai/api/v1/chat/completions');
  assert.equal(options.headers['Helicone-Auth'], 'Bearer helicone-key');
});

test('parses an agree verdict', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"label": "agree", "confidence_level": "высокая", "explanation": "совместимо"}' } }] });
  const judgeContradiction = createContradictionJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' });

  assert.equal(result.label, 'agree');
  assert.equal(result.confidenceLevel, 'высокая');
  assert.equal(result.explanation, 'совместимо');
});

test('parses a contradict verdict', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"label": "contradict", "confidence_level": "средняя", "explanation": "разные суммы"}' } }] });
  const judgeContradiction = createContradictionJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' });

  assert.equal(result.label, 'contradict');
});

test('parses an unclear verdict', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"label": "unclear", "confidence_level": "низкая", "explanation": "не уверен"}' } }] });
  const judgeContradiction = createContradictionJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' });

  assert.equal(result.label, 'unclear');
});

test('strips a ```json code fence before parsing', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '```json\n{"label": "agree", "confidence_level": "высокая", "explanation": "ok"}\n```' } }] });
  const judgeContradiction = createContradictionJudge({ apiKey: 'test-key', fetchImpl });

  const result = await judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' });

  assert.equal(result.label, 'agree');
});

test('throws a descriptive error when the LLM response is not valid JSON', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: 'не JSON' } }] });
  const judgeContradiction = createContradictionJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' }), /invalid JSON/);
});

test('throws a descriptive error when the HTTP response is not ok', async () => {
  const fetchImpl = fakeFetch({}, { ok: false, status: 500 });
  const judgeContradiction = createContradictionJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' }), /HTTP 500/);
});

test('throws a descriptive error when label is missing or invalid', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"confidence_level": "высокая", "explanation": "no label field"}' } }] });
  const judgeContradiction = createContradictionJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' }), /invalid label/);
});

test('throws a descriptive error when confidence_level is missing or invalid', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '{"label": "agree", "confidence_level": "unknown", "explanation": "x"}' } }] });
  const judgeContradiction = createContradictionJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => judgeContradiction({ newClaimText: 'a', existingClaimText: 'b' }), /invalid confidence_level/);
});
