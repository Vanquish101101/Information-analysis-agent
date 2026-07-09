import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAgent1Items } from '../../src/ingestion/agent1Reader.js';
import { makeFakeDb } from '../helpers/fakeSupabase.js';

test('maps search_results rows into normalized items using result.raw', async () => {
  const db = makeFakeDb({
    search_results: () => ({
      data: [
        {
          job_id: 'job-1',
          telegram_id: 123,
          result: { raw: { perplexity: { summary: 'тест' }, youtube: [], firecrawl: [] } },
          telegram_text: 'готовый отчёт',
          confidence: { level: 'высокая', explanation: 'Все источники доступны' },
          meta: { tools_used: ['perplexity'], cost_usd: 0.003, duration_sec: 20 },
          created_at: '2026-07-07T08:00:00Z'
        }
      ],
      error: null
    })
  });

  const items = await fetchAgent1Items(db, { telegramId: 123 });

  assert.equal(items.length, 1);
  assert.equal(items[0].job_id, 'job-1');
  assert.equal(items[0].agent, 1);
  assert.equal(items[0].content_type, 'search');
  assert.deepEqual(items[0].result, { perplexity: { summary: 'тест' }, youtube: [], firecrawl: [] });
  assert.equal(items[0].confidence.level, 'высокая');
});

test('falls back to null result when result.raw is absent, keeps telegram_text_fallback', async () => {
  const db = makeFakeDb({
    search_results: () => ({
      data: [
        {
          job_id: 'job-2',
          telegram_id: 123,
          result: {},
          telegram_text: 'только текстовый отчёт',
          confidence: null,
          meta: null,
          created_at: '2026-07-07T08:05:00Z'
        }
      ],
      error: null
    })
  });

  const items = await fetchAgent1Items(db, { telegramId: 123 });

  assert.equal(items[0].result, null);
  assert.equal(items[0].telegram_text_fallback, 'только текстовый отчёт');
  assert.equal(items[0].confidence.level, 'низкая'); // normalizeItem default
});

test('returns an empty array when there are no rows', async () => {
  const db = makeFakeDb({ search_results: () => ({ data: [], error: null }) });
  const items = await fetchAgent1Items(db, { telegramId: 999 });
  assert.deepEqual(items, []);
});

test('reads search_results from the intelligence_agent schema, not the client default', async () => {
  const db = makeFakeDb({ search_results: () => ({ data: [], error: null }) });
  await fetchAgent1Items(db, { telegramId: 123 });
  assert.deepEqual(db.schemaCalls, ['intelligence_agent']);
});

test('throws a descriptive error when the query fails', async () => {
  const db = makeFakeDb({
    search_results: () => ({ data: null, error: { message: 'connection refused' } })
  });
  await assert.rejects(
    () => fetchAgent1Items(db, { telegramId: 123 }),
    /fetchAgent1Items: connection refused/
  );
});
