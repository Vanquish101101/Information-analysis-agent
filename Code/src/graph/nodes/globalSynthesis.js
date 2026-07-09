// src/graph/nodes/globalSynthesis.js

export function createGlobalSynthesisNode({ db, synthesizeDigest }) {
  return async function globalSynthesisNode(state) {
    const persistedFacts = state.persistedFacts ?? [];
    const persistedContradictions = state.persistedContradictions ?? [];

    if (persistedFacts.length === 0) {
      return {};
    }

    const { data: statsRows, error: statsError } = await db.rpc('claim_source_stats', {
      claim_ids: persistedFacts.map((f) => f.claimId)
    });
    if (statsError) {
      console.error('globalSynthesis: failed to compute claim source stats:', statsError.message);
      return {};
    }
    const statsByClaimId = new Map((statsRows ?? []).map((row) => [row.claim_id, row]));

    const costUsdAnalysis = state.costUsdAnalysis ?? 0;
    const costUsdRetry = state.costUsdRetry ?? 0;

    let statements;
    let synthesisCostUsd;
    try {
      const result = await synthesizeDigest(persistedFacts);
      statements = result.statements;
      synthesisCostUsd = result.costUsd;
    } catch (err) {
      console.error('globalSynthesis: synthesizeDigest failed:', err.message);
      // err.costUsd — деньги, уже реально списанные OpenRouter'ом до сбоя
      // (synthesizeDigest прикрепляет её к ошибке, если HTTP прошёл, но
      // парсинг ответа модели упал) — тот же паттерн, что у остальных
      // LLM-файлов проекта. Без этого UPDATE реально потраченная сумма
      // никогда не попала бы в runs.cost_usd.
      await addSynthesisCostToRun(db, state.runId, costUsdAnalysis, costUsdRetry, err.costUsd ?? 0);
      return {};
    }
    const statementByClaimId = new Map(statements.map((s) => [s.claimId, s.statement]));

    const facts = persistedFacts.map((fact) => {
      const stats = statsByClaimId.get(fact.claimId) ?? { sources_count: 0, reach_estimate: 0 };
      return {
        claim_id: fact.claimId,
        statement: statementByClaimId.get(fact.claimId) ?? `${fact.subject}: ${fact.predicate}: ${fact.object_value ?? ''}`,
        confidence: {
          level: fact.confidence_level,
          sources_count: Number(stats.sources_count),
          reach_estimate: Number(stats.reach_estimate)
        },
        detail_ref: fact.claimId
      };
    });

    const contradictions = persistedContradictions.map((c) => ({
      claim_a_id: c.claimAId,
      claim_b_id: c.claimBId,
      explanation: c.explanation
    }));

    const meta = {
      items_processed: state.items.length,
      escalations_auto: state.escalationsAuto ?? 0,
      escalations_pending_user: state.escalationsPendingUser ?? 0,
      // duration_sec: узел не имеет доступа к моменту старта прогона — задел
      // под "5. ТЗ.md" §3.2, реальное значение появится, когда где-то в
      // графе начнёт трекаться startedAt (не в этом слайсе).
      duration_sec: null,
      cost_usd: costUsdAnalysis + costUsdRetry + synthesisCostUsd
    };

    const { error: digestError } = await db.from('digests').insert({
      run_id: state.runId,
      facts,
      contradictions,
      meta
    });
    if (digestError) {
      console.error('globalSynthesis: failed to save digest:', digestError.message);
      // synthesizeDigest уже отработал и реально стоил денег (synthesisCostUsd)
      // — эта стоимость не должна теряться только из-за того, что сам
      // дайджест не удалось сохранить.
      await addSynthesisCostToRun(db, state.runId, costUsdAnalysis, costUsdRetry, synthesisCostUsd);
      return {};
    }

    // persistResults уже записал "финальную" cost_usd/cost_usd_analysis до
    // того, как этот узел вообще запустился — стоимость самого синтеза
    // добавляется отдельным маленьким UPDATE поверх уже записанного, а не
    // переделкой уже проверенной логики persistResults.
    await addSynthesisCostToRun(db, state.runId, costUsdAnalysis, costUsdRetry, synthesisCostUsd);

    return {};
  };
}

async function addSynthesisCostToRun(db, runId, costUsdAnalysis, costUsdRetry, synthesisCostUsd) {
  const { error } = await db
    .from('runs')
    .update({
      cost_usd: costUsdAnalysis + costUsdRetry + synthesisCostUsd,
      cost_usd_analysis: costUsdAnalysis + synthesisCostUsd
    })
    .eq('id', runId);
  if (error) {
    console.error('globalSynthesis: failed to add synthesis cost to run:', error.message);
  }
}
