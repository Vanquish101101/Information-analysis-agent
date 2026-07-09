// src/graph/nodes/dedup.js
import { Overwrite } from '@langchain/langgraph';

const SIMILARITY_THRESHOLD = 0.85;
const CONFIDENCE_ORDER = ['низкая', 'средняя', 'высокая'];

export function createDedupNode({ db, embedText, judgeDuplicate }) {
  return async function dedupNode(state) {
    const resolvedClaims = [];
    const newErrors = [];
    let costUsdAnalysis = 0;

    for (const claim of state.claims) {
      try {
        const { resolvedClaim, costUsd } = await resolveClaim({ db, embedText, judgeDuplicate, claim });
        resolvedClaims.push(resolvedClaim);
        costUsdAnalysis += costUsd;
      } catch (err) {
        newErrors.push(`dedup failed for claim subject "${claim.subject}": ${err.message}`);
        resolvedClaims.push({
          ...claim,
          isDuplicate: false,
          subjectEntityId: null,
          subjectEmbedding: null,
          claimEmbedding: null,
          batchEntityKey: normalizeKey(claim.subject),
          contradictionCandidate: null
        });
      }
    }

    return {
      claims: new Overwrite(resolvedClaims),
      errors: newErrors,
      costUsdAnalysis
    };
  };
}

async function resolveClaim({ db, embedText, judgeDuplicate, claim }) {
  let costUsd = 0;

  const subjectEmbedded = await embedText(claim.subject);
  costUsd += subjectEmbedded.costUsd;
  const { entityId: subjectEntityId, costUsd: entityCost } = await resolveEntity({ db, judgeDuplicate, claim, subjectEmbedding: subjectEmbedded.embedding });
  costUsd += entityCost;

  if (subjectEntityId) {
    const claimText = buildClaimText(claim);
    const claimEmbedded = await embedText(claimText);
    costUsd += claimEmbedded.costUsd;
    const { candidate, isDuplicate, costUsd: duplicateCost } = await resolveClaimDuplicate({ db, judgeDuplicate, claim, claimEmbedding: claimEmbedded.embedding, subjectEntityId });
    costUsd += duplicateCost;

    if (isDuplicate) {
      return {
        costUsd,
        resolvedClaim: {
          ...claim,
          isDuplicate: true,
          duplicateOfClaimId: candidate.id,
          bumpedConfidenceLevel: bumpConfidence(candidate.confidence_level),
          bumpedConfidenceExplanation: buildBumpedExplanation(candidate.confidence_explanation, claim),
          subjectEntityId,
          contradictionCandidate: null
        }
      };
    }

    return {
      costUsd,
      resolvedClaim: {
        ...claim,
        isDuplicate: false,
        subjectEntityId,
        subjectEmbedding: null,
        claimEmbedding: claimEmbedded.embedding,
        batchEntityKey: null,
        contradictionCandidate: candidate
      }
    };
  }

  // Новая (ещё не существующая) сущность не может иметь существующих claims —
  // проверка на дубль claim'а не нужна, экономим вызов.
  const claimEmbedded = await embedText(buildClaimText(claim));
  costUsd += claimEmbedded.costUsd;
  return {
    costUsd,
    resolvedClaim: {
      ...claim,
      isDuplicate: false,
      subjectEntityId: null,
      subjectEmbedding: subjectEmbedded.embedding,
      claimEmbedding: claimEmbedded.embedding,
      batchEntityKey: normalizeKey(claim.subject),
      contradictionCandidate: null
    }
  };
}

async function resolveEntity({ db, judgeDuplicate, claim, subjectEmbedding }) {
  const { data: candidates, error } = await db.rpc('match_entities', {
    query_embedding: subjectEmbedding,
    match_threshold: SIMILARITY_THRESHOLD
  });

  if (error || !candidates || candidates.length === 0) {
    return { entityId: null, costUsd: 0 };
  }

  const top = candidates[0];
  const verdict = await judgeDuplicate({ kind: 'entity', new: claim.subject, candidate: top.name });
  return { entityId: verdict.isDuplicate ? top.id : null, costUsd: verdict.costUsd };
}

async function resolveClaimDuplicate({ db, judgeDuplicate, claim, claimEmbedding, subjectEntityId }) {
  const { data: candidates, error } = await db.rpc('match_claims', {
    query_embedding: claimEmbedding,
    match_threshold: SIMILARITY_THRESHOLD,
    for_subject_entity_id: subjectEntityId
  });

  if (error || !candidates || candidates.length === 0) {
    return { candidate: null, isDuplicate: false, costUsd: 0 };
  }

  const top = candidates[0];
  const verdict = await judgeDuplicate({
    kind: 'claim',
    new: buildClaimText(claim),
    candidate: `${top.predicate}: ${top.object_value ?? ''}`
  });
  return { candidate: top, isDuplicate: verdict.isDuplicate, costUsd: verdict.costUsd };
}

function buildClaimText(claim) {
  return `${claim.subject}: ${claim.predicate}: ${claim.object_value ?? ''}`;
}

function normalizeKey(subject) {
  return subject.trim().toLowerCase();
}

function bumpConfidence(level) {
  const index = CONFIDENCE_ORDER.indexOf(level);
  if (index === -1 || index === CONFIDENCE_ORDER.length - 1) {
    return level;
  }
  return CONFIDENCE_ORDER[index + 1];
}

function buildBumpedExplanation(oldExplanation, claim) {
  const suffix = `Подтверждено дополнительным источником (agent ${claim.source.agent}, job ${claim.source.jobId}).`;
  return `${oldExplanation ?? ''} ${suffix}`.trim();
}
