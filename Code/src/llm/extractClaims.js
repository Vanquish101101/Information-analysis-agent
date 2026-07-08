
const CONFIDENCE_LEVELS = ['высокая', 'средняя', 'низкая'];

export function createOpenRouterExtractor({ apiKey, model = 'anthropic/claude-haiku-4-5', heliconeApiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) {
    throw new Error('createOpenRouterExtractor: apiKey is required');
  }

  const url = heliconeApiKey
    ? 'https://openrouter.helicone.ai/api/v1/chat/completions'
    : 'https://openrouter.ai/api/v1/chat/completions';

  return async function extractClaims(item) {
    const text = extractableText(item);
    if (!text) {
      return [];
    }

    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://vanquish.information-analysis-agent',
        'X-Title': 'Information Analysis Agent',
        ...(heliconeApiKey ? { 'Helicone-Auth': `Bearer ${heliconeApiKey}` } : {})
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: buildPrompt(text) }],
        max_tokens: 800
      })
    });

    if (!response.ok) {
      throw new Error(`extractClaims: LLM HTTP ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('extractClaims: LLM returned no content');
    }

    return parseClaims(content);
  };
}

function extractableText(item) {
  if (item.result != null) {
    return JSON.stringify(item.result);
  }
  return item.telegram_text_fallback ?? null;
}

function buildPrompt(text) {
  return `Ты — аналитик, который извлекает проверяемые факты (claims) из текста.

ТЕКСТ:
${text.slice(0, 4000)}

Извлеки список фактов в виде строгого JSON-массива, без пояснений и без markdown-обёртки.
Каждый элемент массива — объект с полями:
- subject (строка, о чём/о ком факт)
- predicate (строка, что утверждается)
- object_value (строка, значение/детали)
- confidence_level (одна из строк: "высокая", "средняя", "низкая")
- confidence_explanation (строка, короткое обоснование уровня доверия)

Если фактов нет — верни пустой массив [].
Ответ — только JSON-массив, ничего больше.`;
}

function parseClaims(content) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch (err) {
    throw new Error(`extractClaims: LLM returned invalid JSON: ${err.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('extractClaims: LLM response is not a JSON array');
  }

  return parsed.map((raw, index) => {
    if (!raw.subject || !raw.predicate) {
      throw new Error(`extractClaims: claim at index ${index} missing subject/predicate`);
    }
    if (!CONFIDENCE_LEVELS.includes(raw.confidence_level)) {
      throw new Error(`extractClaims: claim at index ${index} has invalid confidence_level "${raw.confidence_level}"`);
    }
    return {
      subject: raw.subject,
      predicate: raw.predicate,
      object_value: raw.object_value ?? null,
      confidence_level: raw.confidence_level,
      confidence_explanation: raw.confidence_explanation ?? null
    };
  });
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}
