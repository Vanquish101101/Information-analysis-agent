// src/graph/nodes/dedup.js
import { Overwrite } from '@langchain/langgraph';

const SIMILARITY_THRESHOLD = 0.85;
const CONFIDENCE_ORDER = ['низкая', 'средняя', 'высокая'];

export function createDedupNode({ db, embedText, judgeDuplicate }) {
  return async function dedupNode(state) {
    const resolvedClaims = [];
    const newErrors = [];

    for (const claim of state.claims) {
      try {
        resolvedClaims.push(await resolveClaim({ db, embedText, judgeDuplicate, claim }));
      } catch (err) {
        newErrors.push(`dedup failed for claim subject "${claim.subject}": ${err.message}`);
        resolvedClaims.push({
          ...claim,
          isDuplicate: false,
          subjectEntityId: null,
          subjectEmbedding: null,
          claimEmbedding: null,
          batchEntityKey: normalizeKey(claim.subject)
        });
      }
    }

    return {
      claims: new Overwrite(resolvedClaims),
      errors: newErrors
    };
  };
}

async function resolveClaim({ db, embedText, judgeDuplicate, claim }) {
  const subjectEmbedding = await embedText(claim.subject);
  const subjectEntityId = await resolveEntity({ db, judgeDuplicate, claim, subjectEmbedding });

  if (subjectEntityId) {
    const claimText = buildClaimText(claim);
    const claimEmbedding = await embedText(claimText);
    const duplicate = await resolveClaimDuplicate({ db, judgeDuplicate, claim, claimEmbedding, subjectEntityId });

    if (duplicate) {
      return {
        ...claim,
        isDuplicate: true,
        duplicateOfClaimId: duplicate.id,
        bumpedConfidenceLevel: bumpConfidence(duplicate.confidence_level),
        bumpedConfidenceExplanation: buildBumpedExplanation(duplicate.confidence_explanation, claim),
        subjectEntityId
      };
    }

    return {
      ...claim,
      isDuplicate: false,
      subjectEntityId,
      subjectEmbedding: null,
      claimEmbedding,
      batchEntityKey: null
    };
  }

  // Новая (ещё не существующая) сущность не может иметь существующих claims —
  // проверка на дубль claim'а не нужна, экономим вызов.
  const claimEmbedding = await embedText(buildClaimText(claim));
  return {
    ...claim,
    isDuplicate: false,
    subjectEntityId: null,
    subjectEmbedding,
    claimEmbedding,
    batchEntityKey: normalizeKey(claim.subject)
  };
}

async function resolveEntity({ db, judgeDuplicate, claim, subjectEmbedding }) {
  const { data: candidates, error } = await db.rpc('match_entities', {
    query_embedding: subjectEmbedding,
    match_threshold: SIMILARITY_THRESHOLD
  });

  if (error || !candidates || candidates.length === 0) {
    return null;
  }

  const top = candidates[0];
  const verdict = await judgeDuplicate({ kind: 'entity', new: claim.subject, candidate: top.name });
  return verdict.isDuplicate ? top.id : null;
}

async function resolveClaimDuplicate({ db, judgeDuplicate, claim, claimEmbedding, subjectEntityId }) {
  const { data: candidates, error } = await db.rpc('match_claims', {
    query_embedding: claimEmbedding,
    match_threshold: SIMILARITY_THRESHOLD,
    for_subject_entity_id: subjectEntityId
  });

  if (error || !candidates || candidates.length === 0) {
    return null;
  }

  const top = candidates[0];
  const verdict = await judgeDuplicate({
    kind: 'claim',
    new: buildClaimText(claim),
    candidate: `${top.predicate}: ${top.object_value ?? ''}`
  });
  return verdict.isDuplicate ? top : null;
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
