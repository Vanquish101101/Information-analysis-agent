const GEMINI_EMBEDDING_COST_PER_MILLION_TOKENS = 0.15;

export function createGeminiEmbedder({ apiKey, model = 'gemini-embedding-001', heliconeApiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) {
    throw new Error('createGeminiEmbedder: apiKey is required');
  }

  const baseUrl = heliconeApiKey
    ? 'https://gateway.helicone.ai/v1beta/models'
    : 'https://generativelanguage.googleapis.com/v1beta/models';

  return async function embedText(text) {
    const response = await fetchImpl(
      `${baseUrl}/${model}:embedContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(heliconeApiKey
            ? {
                'Helicone-Auth': `Bearer ${heliconeApiKey}`,
                'Helicone-Target-URL': 'https://generativelanguage.googleapis.com'
              }
            : {})
        },
        body: JSON.stringify({
          content: { parts: [{ text }] },
          outputDimensionality: 768
        })
      }
    );

    if (!response.ok) {
      // Найдено живой проверкой 2026-07-12: смена региона VPN/сети привела к
      // реальному 400 FAILED_PRECONDITION "User location is not supported
      // for the API use" — ограничение Google по стране подключения, не
      // проблема ключа. Без этой проверки пользователь видел бы только
      // невнятный "HTTP 400" и не понял бы, что делать.
      const errorBody = await response.json().catch(() => null);
      if (errorBody?.error?.status === 'FAILED_PRECONDITION' && /location is not supported/i.test(errorBody.error?.message ?? '')) {
        throw new Error('embedText: Gemini API недоступен из текущего региона сети/VPN — смени регион и попробуй снова');
      }
      throw new Error(`embedText: Gemini HTTP ${response.status}`);
    }

    const data = await response.json();
    const values = data.embedding?.values;
    if (!Array.isArray(values)) {
      throw new Error('embedText: Gemini response missing embedding values');
    }
    if (values.length !== 768) {
      throw new Error(`embedText: expected 768 dimensions, got ${values.length}`);
    }

    return { embedding: values, costUsd: estimateCostUsd(text) };
  };
}

// Gemini embedContent сообщает только embedding, без токенов/стоимости —
// это ВСЕГДА оценка (не точная цена, в отличие от OpenRouter usage.cost),
// по официальному тарифу $0.15/1М входных токенов, ~4 символа на токен.
function estimateCostUsd(text) {
  const estimatedTokens = Math.ceil(text.length / 4);
  return (estimatedTokens / 1_000_000) * GEMINI_EMBEDDING_COST_PER_MILLION_TOKENS;
}
