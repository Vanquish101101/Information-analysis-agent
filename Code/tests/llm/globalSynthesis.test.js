import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGlobalSynthesisJudge } from '../../src/llm/globalSynthesis.js';

function fakeFetch(responseBody, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok, status, json: async () => responseBody };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function fact(overrides = {}) {
  return {
    claimId: 'claim-1',
    subject: 'Компания X',
    predicate: 'подняла раунд',
    object_value: '5 млн',
    confidence_level: 'высокая',
    ...overrides
  };
}

test('throws when apiKey is missing', () => {
  assert.throws(() => createGlobalSynthesisJudge({}), /apiKey is required/);
});

test('returns empty statements and costUsd 0 without calling fetch when facts is empty', async () => {
  const fetchImpl = fakeFetch({});
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'test-key', fetchImpl });

  const result = await synthesizeDigest([]);

  assert.deepEqual(result, { statements: [], costUsd: 0 });
  assert.equal(fetchImpl.calls.length, 0);
});

test('builds the request with the correct URL, model, all claim_ids in the prompt, and usage:{include:true}', async () => {
  const fetchImpl = fakeFetch({
    choices: [{ message: { content: '[{"claim_id": "claim-1", "statement": "Компания X подняла 5 млн."}]' } }],
    usage: { cost: 0.0004 }
  });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'secret-key', fetchImpl });

  await synthesizeDigest([fact()]);

  assert.equal(fetchImpl.calls.length, 1);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(options.headers['Authorization'], 'Bearer secret-key');
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'anthropic/claude-sonnet-4-6');
  assert.deepEqual(body.usage, { include: true });
  assert.match(body.messages[0].content, /claim-1/);
  assert.match(body.messages[0].content, /Компания X/);
});

test('routes through Helicone proxy and adds Helicone-Auth header when heliconeApiKey is set', async () => {
  const fetchImpl = fakeFetch({
    choices: [{ message: { content: '[{"claim_id": "claim-1", "statement": "ok"}]' } }],
    usage: { cost: 0.0001 }
  });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'secret-key', heliconeApiKey: 'helicone-key', fetchImpl });

  await synthesizeDigest([fact()]);

  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.helicone.ai/api/v1/chat/completions');
  assert.equal(options.headers['Helicone-Auth'], 'Bearer helicone-key');
});

test('parses statements for multiple facts', async () => {
  const fetchImpl = fakeFetch({
    choices: [{
      message: {
        content: JSON.stringify([
          { claim_id: 'claim-1', statement: 'Факт один.' },
          { claim_id: 'claim-2', statement: 'Факт два.' }
        ])
      }
    }],
    usage: { cost: 0.0006 }
  });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'test-key', fetchImpl });

  const result = await synthesizeDigest([fact(), fact({ claimId: 'claim-2', subject: 'Компания Y' })]);

  assert.equal(result.statements.length, 2);
  assert.equal(result.statements[0].claimId, 'claim-1');
  assert.equal(result.statements[0].statement, 'Факт один.');
  assert.equal(result.statements[1].claimId, 'claim-2');
});

test('returns the real cost from usage.cost', async () => {
  const fetchImpl = fakeFetch({
    choices: [{ message: { content: '[{"claim_id": "claim-1", "statement": "ok"}]' } }],
    usage: { cost: 0.00051 }
  });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'test-key', fetchImpl });

  const result = await synthesizeDigest([fact()]);

  assert.equal(result.costUsd, 0.00051);
});

test('defaults costUsd to 0 when the response has no usage.cost field', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: '[{"claim_id": "claim-1", "statement": "ok"}]' } }] });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'test-key', fetchImpl });

  const result = await synthesizeDigest([fact()]);

  assert.equal(result.costUsd, 0);
});

test('strips a ```json code fence before parsing', async () => {
  const fetchImpl = fakeFetch({
    choices: [{ message: { content: '```json\n[{"claim_id": "claim-1", "statement": "ok"}]\n```' } }],
    usage: { cost: 0.0001 }
  });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'test-key', fetchImpl });

  const result = await synthesizeDigest([fact()]);

  assert.equal(result.statements[0].statement, 'ok');
});

test('throws a descriptive error when the LLM response is not valid JSON', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: 'не JSON' } }] });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => synthesizeDigest([fact()]), /invalid JSON/);
});

test('attaches the real already-incurred costUsd to the thrown error when parsing fails after a successful paid HTTP call', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: 'не JSON' } }], usage: { cost: 0.0008 } });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'test-key', fetchImpl });

  try {
    await synthesizeDigest([fact()]);
    assert.fail('expected synthesizeDigest to throw');
  } catch (err) {
    assert.equal(err.costUsd, 0.0008);
  }
});

test('throws a descriptive error when the HTTP response is not ok', async () => {
  const fetchImpl = fakeFetch({}, { ok: false, status: 500 });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => synthesizeDigest([fact()]), /HTTP 500/);
});

test('throws a descriptive error when a statement references an unknown claim_id', async () => {
  const fetchImpl = fakeFetch({
    choices: [{ message: { content: '[{"claim_id": "claim-unknown", "statement": "ok"}]' } }],
    usage: { cost: 0.0001 }
  });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => synthesizeDigest([fact()]), /unknown claim_id/);
});

test('throws a descriptive error when a statement entry is missing statement text', async () => {
  const fetchImpl = fakeFetch({
    choices: [{ message: { content: '[{"claim_id": "claim-1"}]' } }],
    usage: { cost: 0.0001 }
  });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => synthesizeDigest([fact()]), /missing statement/);
});
