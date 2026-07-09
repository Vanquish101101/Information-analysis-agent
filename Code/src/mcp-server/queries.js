// src/mcp-server/queries.js

export async function getDigest(db, runId) {
  const query = runId
    ? db.from('digests').select().eq('run_id', runId)
    : db.from('digests').select().order('run_at', { ascending: false }).limit(1);
  const { data, error } = await query;
  if (error) {
    throw new Error(`getDigest: ${error.message}`);
  }
  const row = data?.[0];
  if (!row) {
    return { digest_id: null, run_at: null, facts: [], contradictions: [], meta: null };
  }
  return {
    digest_id: row.id,
    run_at: row.run_at,
    facts: row.facts,
    contradictions: row.contradictions,
    meta: row.meta
  };
}

export async function getClaimDetail(db, claimId) {
  const { data: claimRows, error: claimError } = await db.from('claims').select().eq('id', claimId);
  if (claimError) {
    throw new Error(`getClaimDetail: failed to read claim: ${claimError.message}`);
  }
  const claim = claimRows?.[0];
  if (!claim) {
    return null;
  }

  const { data: entityRows, error: entityError } = await db.from('entities').select().eq('id', claim.subject_entity_id);
  if (entityError) {
    throw new Error(`getClaimDetail: failed to read entity: ${entityError.message}`);
  }
  const subjectName = entityRows?.[0]?.name ?? '(неизвестно)';

  const { data: linkRows, error: linkError } = await db.from('claim_sources').select().eq('claim_id', claimId);
  if (linkError) {
    throw new Error(`getClaimDetail: failed to read claim_sources: ${linkError.message}`);
  }

  const sources = [];
  for (const link of linkRows ?? []) {
    const { data: sourceRows, error: sourceError } = await db.from('sources').select().eq('id', link.source_id);
    if (sourceError) {
      throw new Error(`getClaimDetail: failed to read source ${link.source_id}: ${sourceError.message}`);
    }
    const source = sourceRows?.[0];
    if (!source) {
      continue;
    }
    sources.push({
      source_id: source.id,
      type: source.source_type,
      ref: source.raw_job_id,
      excerpt: null,
      confidence: claim.confidence_level
    });
  }

  return {
    claim_id: claim.id,
    statement: `${subjectName}: ${claim.predicate}: ${claim.object_value ?? ''}`,
    sources,
    reasoning: claim.confidence_explanation,
    history: []
  };
}

export async function getStatus(db) {
  const { data: runRows, error: runError } = await db.from('runs').select().order('run_at', { ascending: false }).limit(1);
  if (runError) {
    throw new Error(`getStatus: failed to read runs: ${runError.message}`);
  }
  const run = runRows?.[0];

  const { data: pendingRows, error: pendingError } = await db.from('pending_user_decisions').select().eq('status', 'pending');
  if (pendingError) {
    throw new Error(`getStatus: failed to read pending_user_decisions: ${pendingError.message}`);
  }

  return {
    last_run_at: run?.run_at ?? null,
    status: run?.status ?? null,
    items_processed: run?.items_processed ?? 0,
    cost_usd: run?.cost_usd ?? 0,
    pending_user_decisions: (pendingRows ?? []).map((p) => ({
      job_id: p.job_id,
      question: p.question,
      estimated_cost_usd: p.estimated_cost_usd
    }))
  };
}
