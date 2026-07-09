import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiEmbedder } from '../../src/embeddings/embedText.js';

function fakeFetch(responseBody, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok, status, json: async () => responseBody };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function embeddingOf(length, fill = 0.01) {
  return Array.from({ length }, () => fill);
}

test('throws when apiKey is missing', () => {
  assert.throws(() => createGeminiEmbedder({}), /apiKey is required/);
});

test('requests outputDimensionality: 768 and hits the embedContent endpoint', async () => {
  const fetchImpl = fakeFetch({ embedding: { values: embeddingOf(768) } });
  const embedText = createGeminiEmbedder({ apiKey: 'test-key', fetchImpl });

  await embedText('some text');

  assert.equal(fetchImpl.calls.length, 1);
  const { url, options } = fetchImpl.calls[0];
  assert.match(url, /gemini-embedding-001:embedContent\?key=test-key$/);
  const body = JSON.parse(options.body);
  assert.equal(body.outputDimensionality, 768);
  assert.equal(body.content.parts[0].text, 'some text');
});

test('routes through Helicone gateway with target-URL header when heliconeApiKey is set', async () => {
  const fetchImpl = fakeFetch({ embedding: { values: embeddingOf(768) } });
  const embedText = createGeminiEmbedder({ apiKey: 'test-key', heliconeApiKey: 'helicone-key', fetchImpl });

  await embedText('some text');

  assert.equal(fetchImpl.calls.length, 1);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://gateway.helicone.ai/v1beta/models/gemini-embedding-001:embedContent?key=test-key');
  assert.equal(options.headers['Helicone-Auth'], 'Bearer helicone-key');
  assert.equal(options.headers['Helicone-Target-URL'], 'https://generativelanguage.googleapis.com');
});

test('returns the embedding array on success', async () => {
  const fetchImpl = fakeFetch({ embedding: { values: embeddingOf(768, 0.5) } });
  const embedText = createGeminiEmbedder({ apiKey: 'test-key', fetchImpl });

  const result = await embedText('some text');

  assert.equal(result.embedding.length, 768);
  assert.equal(result.embedding[0], 0.5);
});

test('estimates costUsd from text length ($0.15 per 1M tokens, ~4 chars/token)', async () => {
  const fetchImpl = fakeFetch({ embedding: { values: embeddingOf(768) } });
  const embedText = createGeminiEmbedder({ apiKey: 'test-key', fetchImpl });

  const text = 'a'.repeat(4000); // ~1000 estimated tokens
  const result = await embedText(text);

  const expectedTokens = Math.ceil(text.length / 4);
  const expectedCostUsd = (expectedTokens / 1_000_000) * 0.15;
  assert.equal(result.costUsd, expectedCostUsd);
});

test('throws a descriptive error when the HTTP response is not ok', async () => {
  const fetchImpl = fakeFetch({}, { ok: false, status: 429 });
  const embedText = createGeminiEmbedder({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => embedText('x'), /HTTP 429/);
});

test('throws a descriptive error when the response has no embedding values', async () => {
  const fetchImpl = fakeFetch({});
  const embedText = createGeminiEmbedder({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => embedText('x'), /missing embedding values/);
});

test('throws a descriptive error when the dimension is not 768', async () => {
  const fetchImpl = fakeFetch({ embedding: { values: embeddingOf(3072) } });
  const embedText = createGeminiEmbedder({ apiKey: 'test-key', fetchImpl });

  await assert.rejects(() => embedText('x'), /expected 768 dimensions, got 3072/);
});
