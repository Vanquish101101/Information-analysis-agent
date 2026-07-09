export function createExtractClaimsNode(extractClaims) {
  return async function extractClaimsNode({ item }) {
    try {
      const { claims: rawClaims, costUsd } = await extractClaims(item);
      const claims = rawClaims.map((claim) => ({
        ...claim,
        source: { agent: item.agent, jobId: item.job_id, refType: item.content_type, reachEstimate: item.reachEstimate ?? 0 }
      }));
      return { claims, costUsdAnalysis: costUsd };
    } catch (err) {
      // err.costUsd — стоимость, уже реально потраченная до сбоя (extractClaims
      // прикрепляет её к ошибке, если HTTP прошёл, но парсинг ответа модели
      // упал). costUsdAnalysis — sum-reducer канал: ключ должен полностью
      // отсутствовать в обновлении, если вклада нет, иначе передача
      // costUsdAnalysis: undefined в reducer даст NaN.
      return {
        errors: [`item ${item.job_id}: ${err.message}`],
        ...(err.costUsd ? { costUsdAnalysis: err.costUsd } : {})
      };
    }
  };
}
