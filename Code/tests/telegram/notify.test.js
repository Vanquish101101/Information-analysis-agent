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

// Симулирует последовательность разных ответов на последовательные вызовы —
// нужно для fallback-сценария (первый вызов падает с 400 parse entities,
// второй — уже без parse_mode — успевает успешно).
function fakeFetchSequence(responses) {
  const calls = [];
  let call = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const { body, ok = true, status = 200 } = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return {
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body)
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

test('throws a descriptive error when the HTTP response is not ok (and is not a Markdown parse-entities error)', async () => {
  const fetchImpl = fakeFetch({ ok: false, description: 'chat not found' }, { ok: false, status: 400 });
  const sendNotification = createTelegramNotifier({ botToken: 'test-token', chatId: '123456', fetchImpl });

  await assert.rejects(() => sendNotification('x'), /HTTP 400/);
  assert.equal(fetchImpl.calls.length, 1, 'does not retry a non-parse-entities failure');
});

test('retries as plain text (no parse_mode, Markdown special chars stripped) when Telegram rejects the Markdown with a parse-entities 400', async () => {
  const fetchImpl = fakeFetchSequence([
    { body: { ok: false, description: "Bad Request: can't parse entities: Character '_' is reserved" }, ok: false, status: 400 },
    { body: { ok: true, result: { message_id: 7 } }, ok: true, status: 200 }
  ]);
  const sendNotification = createTelegramNotifier({ botToken: 'test-token', chatId: '123456', fetchImpl });

  const result = await sendNotification('Компания X_Y: подняла раунд: *5 млн*');

  assert.equal(fetchImpl.calls.length, 2, 'retried once after the Markdown parse failure');
  const firstBody = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(firstBody.parse_mode, 'Markdown');
  const secondBody = JSON.parse(fetchImpl.calls[1].options.body);
  assert.equal(secondBody.parse_mode, undefined, 'fallback request has no parse_mode at all (plain text)');
  assert.equal(secondBody.text, 'Компания XY: подняла раунд: 5 млн', 'Markdown special characters (_,*) stripped from the fallback text');
  assert.equal(result.result.message_id, 7);
});

test('a genuine second failure on the plain-text fallback still throws (does not retry forever)', async () => {
  const fetchImpl = fakeFetchSequence([
    { body: { ok: false, description: "can't parse entities" }, ok: false, status: 400 },
    { body: { ok: false, description: 'chat not found' }, ok: false, status: 400 }
  ]);
  const sendNotification = createTelegramNotifier({ botToken: 'test-token', chatId: '123456', fetchImpl });

  await assert.rejects(() => sendNotification('x_y'), /HTTP 400/);
  assert.equal(fetchImpl.calls.length, 2);
});
