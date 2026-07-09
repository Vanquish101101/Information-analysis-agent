export function createGlobalSynthesisJudge({ apiKey, model = 'anthropic/claude-sonnet-4-6', heliconeApiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) {
    throw new Error('createGlobalSynthesisJudge: apiKey is required');
  }

  const url = heliconeApiKey
    ? 'https://openrouter.helicone.ai/api/v1/chat/completions'
    : 'https://openrouter.ai/api/v1/chat/completions';

  return async function synthesizeDigest(facts) {
    if (facts.length === 0) {
      return { statements: [], costUsd: 0 };
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
        messages: [{ role: 'user', content: buildPrompt(facts) }],
        max_tokens: 4000,
        usage: { include: true }
      })
    });

    if (!response.ok) {
      throw new Error(`synthesizeDigest: LLM HTTP ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('synthesizeDigest: LLM returned no content');
    }

    const costUsd = data.usage?.cost ?? 0;
    try {
      return { statements: parseStatements(content, facts), costUsd };
    } catch (err) {
      err.costUsd = costUsd;
      throw err;
    }
  };
}

function buildPrompt(facts) {
  const factsList = facts
    .map((f) => `- claim_id: ${f.claimId}\n  ${f.subject}: ${f.predicate}: ${f.object_value ?? ''} (confidence: ${f.confidence_level})`)
    .join('\n');

  return `Ты — аналитик, который формулирует связный читаемый текст факта для дайджеста.

ФАКТЫ (subject/predicate/object_value):
${factsList}

Для каждого факта сформулируй одно связное предложение (statement) на основе его subject/predicate/object_value.
Ответь строго JSON-массивом объектов, без пояснений и без markdown-обёртки:
[{"claim_id": "...", "statement": "..."}]`;
}

function parseStatements(content, facts) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch (err) {
    throw new Error(`synthesizeDigest: LLM returned invalid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('synthesizeDigest: LLM response is not a JSON array');
  }

  const knownIds = new Set(facts.map((f) => f.claimId));
  return parsed.map((raw, index) => {
    if (!raw.claim_id || !knownIds.has(raw.claim_id)) {
      throw new Error(`synthesizeDigest: statement at index ${index} has unknown claim_id "${raw.claim_id}"`);
    }
    if (!raw.statement) {
      throw new Error(`synthesizeDigest: statement at index ${index} missing statement text`);
    }
    return { claimId: raw.claim_id, statement: raw.statement };
  });
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}
