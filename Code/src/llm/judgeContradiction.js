const LABELS = ['agree', 'contradict', 'unclear'];
const CONFIDENCE_LEVELS = ['высокая', 'средняя', 'низкая'];

export function createContradictionJudge({ apiKey, model = 'anthropic/claude-haiku-4-5', heliconeApiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) {
    throw new Error('createContradictionJudge: apiKey is required');
  }

  const url = heliconeApiKey
    ? 'https://openrouter.helicone.ai/api/v1/chat/completions'
    : 'https://openrouter.ai/api/v1/chat/completions';

  return async function judgeContradiction({ newClaimText, existingClaimText }) {
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
        messages: [{ role: 'user', content: buildPrompt(newClaimText, existingClaimText) }],
        max_tokens: 300,
        usage: { include: true }
      })
    });

    if (!response.ok) {
      throw new Error(`judgeContradiction: LLM HTTP ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('judgeContradiction: LLM returned no content');
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

function buildPrompt(newClaimText, existingClaimText) {
  return `Ты — судья, определяющий, противоречат ли друг другу два факта об одном и том же предмете.

НОВЫЙ ФАКТ: ${newClaimText}
СУЩЕСТВУЮЩИЙ ФАКТ: ${existingClaimText}

Согласуются ли эти факты (уточняют или дополняют друг друга), явно противоречат друг другу
(взаимоисключающие утверждения), или непонятно?
Ответь строго JSON-объектом без пояснений вокруг:
{"label": "agree"|"contradict"|"unclear", "confidence_level": "высокая"|"средняя"|"низкая", "explanation": "краткое обоснование"}`;
}

function parseVerdict(content) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch (err) {
    throw new Error(`judgeContradiction: LLM returned invalid JSON: ${err.message}`);
  }
  if (!LABELS.includes(parsed.label)) {
    throw new Error(`judgeContradiction: invalid label "${parsed.label}"`);
  }
  if (!CONFIDENCE_LEVELS.includes(parsed.confidence_level)) {
    throw new Error(`judgeContradiction: invalid confidence_level "${parsed.confidence_level}"`);
  }
  return {
    label: parsed.label,
    confidenceLevel: parsed.confidence_level,
    explanation: parsed.explanation ?? null
  };
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}
