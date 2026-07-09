// src/telegram/notify.js

// Убирает Markdown-символы для fallback-отправки без форматирования — тот
// же паттерн, что уже используется у Агента 1 (Intelligence agent/Code/
// src/telegram-bot/index.js: stripMd/safeSend). Динамический текст в
// сообщении (subject/predicate/object_value факта, explanation судьи,
// question эскалации) приходит из LLM-извлечения произвольного исходного
// текста — непроэкранированные *,_,`,[,] ломают parse_mode: 'Markdown' с
// HTTP 400 "can't parse entities", и без fallback'а такое уведомление
// молча терялось бы целиком (notifications.js ловит любую ошибку отправки
// и просто логирует, не бросает дальше).
function stripMarkdown(text) {
  return text.replace(/[*_`[\]]/g, '');
}

export function createTelegramNotifier({ botToken, chatId, fetchImpl = fetch } = {}) {
  if (!botToken) {
    throw new Error('createTelegramNotifier: botToken is required');
  }
  if (!chatId) {
    throw new Error('createTelegramNotifier: chatId is required');
  }

  async function postMessage(text, { parseMode } = {}) {
    const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {})
      })
    });

    if (!response.ok) {
      const body = await response.text();
      const err = new Error(`sendNotification: Telegram HTTP ${response.status}: ${body}`);
      err.status = response.status;
      err.body = body;
      throw err;
    }

    return response.json();
  }

  return async function sendNotification(text) {
    try {
      return await postMessage(text, { parseMode: 'Markdown' });
    } catch (err) {
      const isMarkdownParseError = err.status === 400 && /parse entities/i.test(err.body ?? '');
      if (!isMarkdownParseError) {
        throw err;
      }
      return postMessage(stripMarkdown(text));
    }
  };
}
