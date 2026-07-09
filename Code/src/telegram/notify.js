// src/telegram/notify.js
export function createTelegramNotifier({ botToken, chatId, fetchImpl = fetch } = {}) {
  if (!botToken) {
    throw new Error('createTelegramNotifier: botToken is required');
  }
  if (!chatId) {
    throw new Error('createTelegramNotifier: chatId is required');
  }

  return async function sendNotification(text) {
    const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`sendNotification: Telegram HTTP ${response.status}: ${body}`);
    }

    return response.json();
  };
}
