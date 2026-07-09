export function createExtractClaimsNode(extractClaims) {
  return async function extractClaimsNode({ item }) {
    try {
      const { claims: rawClaims, costUsd } = await extractClaims(item);
      const claims = rawClaims.map((claim) => ({
        ...claim,
        source: { agent: item.agent, jobId: item.job_id, refType: item.content_type }
      }));
      return { claims, costUsdAnalysis: costUsd };
    } catch (err) {
      return { errors: [`item ${item.job_id}: ${err.message}`] };
    }
  };
}
