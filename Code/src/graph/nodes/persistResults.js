// src/graph/nodes/persistResults.js

export function createPersistResultsNode({ db }) {
  return async function persistResultsNode(state) {
    const { data: runRow, error: runError } = await db
      .from('runs')
      .insert({ status: 'running', items_processed: state.items.length, cost_usd: 0 })
      .select()
      .single();

    if (runError) {
      throw new Error(`persistResults: failed to create run: ${runError.message}`);
    }

    const runId = runRow.id;

    try {
      const sourceIds = new Map();
      for (const claim of state.claims) {
        const sourceKey = `${claim.source.agent}:${claim.source.jobId}`;
        if (!sourceIds.has(sourceKey)) {
          const { data: sourceRow, error: sourceError } = await db
            .from('sources')
            .insert({
              agent: claim.source.agent,
              source_type: claim.source.refType,
              raw_job_id: claim.source.jobId
            })
            .select()
            .single();
          if (sourceError) {
            throw new Error(`persistResults: failed to create source: ${sourceError.message}`);
          }
          sourceIds.set(sourceKey, sourceRow.id);
        }
      }

      const newEntityIds = new Map();
      for (const claim of state.claims) {
        if (claim.isDuplicate) continue;
        if (claim.subjectEntityId) {
          const { error: touchError } = await db
            .from('entities')
            .update({ last_seen_at: new Date().toISOString() })
            .eq('id', claim.subjectEntityId);
          if (touchError) {
            throw new Error(`persistResults: failed to update entity last_seen_at: ${touchError.message}`);
          }
          continue;
        }
        if (!newEntityIds.has(claim.batchEntityKey)) {
          const { data: entityRow, error: entityError } = await db
            .from('entities')
            .insert({ name: claim.subject, embedding: claim.subjectEmbedding })
            .select()
            .single();
          if (entityError) {
            throw new Error(`persistResults: failed to create entity: ${entityError.message}`);
          }
          newEntityIds.set(claim.batchEntityKey, entityRow.id);
        }
      }

      for (const claim of state.claims) {
        const sourceKey = `${claim.source.agent}:${claim.source.jobId}`;
        const sourceId = sourceIds.get(sourceKey);

        if (claim.isDuplicate) {
          const { error: updateError } = await db
            .from('claims')
            .update({
              confidence_level: claim.bumpedConfidenceLevel,
              confidence_explanation: claim.bumpedConfidenceExplanation
            })
            .eq('id', claim.duplicateOfClaimId);
          if (updateError) {
            throw new Error(`persistResults: failed to update duplicate claim: ${updateError.message}`);
          }
          continue;
        }

        // dedup.js's error-fallback path (embedText/judgeDuplicate/RPC threw for
        // this claim) leaves claimEmbedding null — the claim couldn't be
        // resolved at all, and the failure is already recorded in
        // state.errors. Skip persisting a claims row for it: inserting one
        // with a null embedding would either violate the vector column or
        // silently create a claim unfindable by future dedup lookups.
        if (claim.claimEmbedding == null) continue;

        const subjectEntityId = claim.subjectEntityId ?? newEntityIds.get(claim.batchEntityKey);

        const { data: claimRow, error: claimError } = await db
          .from('claims')
          .insert({
            subject_entity_id: subjectEntityId,
            predicate: claim.predicate,
            object_value: claim.object_value,
            confidence_level: claim.confidence_level,
            confidence_explanation: claim.confidence_explanation,
            source_id: sourceId,
            embedding: claim.claimEmbedding
          })
          .select()
          .single();
        if (claimError) {
          throw new Error(`persistResults: failed to create claim: ${claimError.message}`);
        }

        if (claim.hasContradiction) {
          const { error: contradictionError } = await db
            .from('contradictions')
            .insert({
              claim_a_id: claimRow.id,
              claim_b_id: claim.contradictsClaimId,
              label: claim.contradictionRawLabel,
              confidence_level: claim.contradictionConfidenceLevel,
              explanation: claim.contradictionExplanation
            });
          if (contradictionError) {
            console.error(`persistResults: failed to record contradiction for claim ${claimRow.id}:`, contradictionError.message);
          }
        }
      }

      const finalStatus = state.costCapReached ? 'cost_cap_reached' : (state.errors.length > 0 ? 'partial' : 'ok');
      const { error: statusUpdateError } = await db
        .from('runs')
        .update({
          status: finalStatus,
          cost_usd: (state.costUsdAnalysis ?? 0) + (state.costUsdRetry ?? 0),
          cost_usd_analysis: state.costUsdAnalysis ?? 0,
          cost_usd_retry: state.costUsdRetry ?? 0,
          escalations_auto: state.escalationsAuto ?? 0,
          escalations_pending_user: state.escalationsPendingUser ?? 0
        })
        .eq('id', runId);
      if (statusUpdateError) {
        console.error(`persistResults: failed to update run status to "${finalStatus}":`, statusUpdateError.message);
      }

      return { runId, status: finalStatus };
    } catch (err) {
      const { error: rollbackError } = await db.from('runs').update({ status: 'error' }).eq('id', runId);
      if (rollbackError) {
        console.error('persistResults: failed to update run status to "error" during rollback:', rollbackError.message);
      }
      throw err;
    }
  };
}
