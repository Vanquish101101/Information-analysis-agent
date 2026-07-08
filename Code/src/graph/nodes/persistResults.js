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

      for (const claim of state.claims) {
        const sourceKey = `${claim.source.agent}:${claim.source.jobId}`;
        const sourceId = sourceIds.get(sourceKey);

        const { data: entityRow, error: entityError } = await db
          .from('entities')
          .insert({ name: claim.subject })
          .select()
          .single();
        if (entityError) {
          throw new Error(`persistResults: failed to create entity: ${entityError.message}`);
        }

        const { error: claimError } = await db
          .from('claims')
          .insert({
            subject_entity_id: entityRow.id,
            predicate: claim.predicate,
            object_value: claim.object_value,
            confidence_level: claim.confidence_level,
            confidence_explanation: claim.confidence_explanation,
            source_id: sourceId
          });
        if (claimError) {
          throw new Error(`persistResults: failed to create claim: ${claimError.message}`);
        }
      }

      const finalStatus = state.errors.length > 0 ? 'partial' : 'ok';
      const { error: statusUpdateError } = await db.from('runs').update({ status: finalStatus }).eq('id', runId);
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
