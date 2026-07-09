export function createDuplicateJudge({ apiKey, model = 'anthropic/claude-haiku-4-5', heliconeApiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) {
    throw new Error('createDuplicateJudge: apiKey is required');
  }

  const url = heliconeApiKey
    ? 'https://openrouter.helicone.ai/api/v1/chat/completions'
    : 'https://openrouter.ai/api/v1/chat/completions';

  return async function judgeDuplicate({ kind, new: newText, candidate }) {
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
        messages: [{ role: 'user', content: buildPrompt(kind, newText, candidate) }],
        max_tokens: 300,
        usage: { include: true }
      })
    });

    if (!response.ok) {
      throw new Error(`judgeDuplicate: LLM HTTP ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('judgeDuplicate: LLM returned no content');
    }

    // usage.cost — реальные деньги, уже потраченные к этому моменту (HTTP-
    // вызов прошёл успешно). Если parseVerdict бросит исключение из-за
    // некорректного JSON от модели, эта стоимость всё равно должна дойти до
    // вызывающего кода, а не потеряться вместе с исключением.
    const costUsd = data.usage?.cost ?? 0;
    try {
      return { ...parseVerdict(content), costUsd };
    } catch (err) {
      err.costUsd = costUsd;
      throw err;
    }
  };
}

function buildPrompt(kind, newText, candidate) {
  const subject = kind === 'entity' ? 'сущности (entity)' : 'факта (claim)';
  return `Ты — судья, определяющий дубликаты ${subject}.

НОВОЕ: ${newText}
СУЩЕСТВУЮЩЕЕ: ${candidate}

Это одно и то же (с учётом разных формулировок/языка), или разные вещи?
Ответь строго JSON-объектом без пояснений вокруг:
{"is_duplicate": true|false, "reasoning": "краткое обоснование"}`;
}

function parseVerdict(content) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch (err) {
    throw new Error(`judgeDuplicate: LLM returned invalid JSON: ${err.message}`);
  }
  if (typeof parsed.is_duplicate !== 'boolean') {
    throw new Error('judgeDuplicate: LLM response missing boolean is_duplicate');
  }
  return {
    isDuplicate: parsed.is_duplicate,
    reasoning: parsed.reasoning ?? null
  };
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}
