import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramNotifier } from '../../src/telegram/notify.js';

function fakeFetch(responseBody, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok,
      status,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody)
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('throws when botToken is missing', () => {
  assert.throws(() => createTelegramNotifier({ chatId: '123456' }), /botToken is required/);
});

test('throws when chatId is missing', () => {
  assert.throws(() => createTelegramNotifier({ botToken: 'test-token' }), /chatId is required/);
});

test('sends a POST to the correct Telegram sendMessage URL with chat_id/text/parse_mode', async () => {
  const fetchImpl = fakeFetch({ ok: true, result: { message_id: 1 } });
  const sendNotification = createTelegramNotifier({ botToken: 'test-token', chatId: '123456', fetchImpl });

  await sendNotification('Привет, это тест');

  assert.equal(fetchImpl.calls.length, 1);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://api.telegram.org/bottest-token/sendMessage');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Content-Type'], 'application/json');
  const body = JSON.parse(options.body);
  assert.equal(body.chat_id, '123456');
  assert.equal(body.text, 'Привет, это тест');
  assert.equal(body.parse_mode, 'Markdown');
});

test('returns the parsed JSON response on success', async () => {
  const fetchImpl = fakeFetch({ ok: true, result: { message_id: 42 } });
  const sendNotification = createTelegramNotifier({ botToken: 'test-token', chatId: '123456', fetchImpl });

  const result = await sendNotification('x');

  assert.equal(result.result.message_id, 42);
});

test('throws a descriptive error when the HTTP response is not ok', async () => {
  const fetchImpl = fakeFetch({ ok: false, description: 'chat not found' }, { ok: false, status: 400 });
  const sendNotification = createTelegramNotifier({ botToken: 'test-token', chatId: '123456', fetchImpl });

  await assert.rejects(() => sendNotification('x'), /HTTP 400/);
});
