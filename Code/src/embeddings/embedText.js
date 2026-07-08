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

    return values;
  };
}
