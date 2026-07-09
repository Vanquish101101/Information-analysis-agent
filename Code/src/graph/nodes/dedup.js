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
      // costTracker накапливает costUsd по мере выполнения отдельных await —
      // не только на успешном return: если resolveClaim бросит исключение
      // на полпути (например, embedText отработал и стоил денег, а
      // последующий judgeDuplicate упал), уже понесённая стоимость не
      // теряется, а всё равно попадает в costUsdAnalysis через finally.
      const costTracker = { value: 0 };
      try {
        const resolvedClaim = await resolveClaim({ db, embedText, judgeDuplicate, claim, costTracker });
        resolvedClaims.push(resolvedClaim);
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
      } finally {
        costUsdAnalysis += costTracker.value;
      }
    }

    return {
      claims: new Overwrite(resolvedClaims),
      errors: newErrors,
      costUsdAnalysis
    };
  };
}

async function resolveClaim({ db, embedText, judgeDuplicate, claim, costTracker }) {
  const subjectEmbedded = await embedText(claim.subject);
  costTracker.value += subjectEmbedded.costUsd;
  const subjectEntityId = await resolveEntity({ db, judgeDuplicate, claim, subjectEmbedding: subjectEmbedded.embedding, costTracker });

  if (subjectEntityId) {
    const claimText = buildClaimText(claim);
    const claimEmbedded = await embedText(claimText);
    costTracker.value += claimEmbedded.costUsd;
    const { candidate, isDuplicate } = await resolveClaimDuplicate({ db, judgeDuplicate, claim, claimEmbedding: claimEmbedded.embedding, subjectEntityId, costTracker });

    if (isDuplicate) {
      return {
        ...claim,
        isDuplicate: true,
        duplicateOfClaimId: candidate.id,
        bumpedConfidenceLevel: bumpConfidence(candidate.confidence_level),
        bumpedConfidenceExplanation: buildBumpedExplanation(candidate.confidence_explanation, claim),
        subjectEntityId,
        contradictionCandidate: null
      };
    }

    return {
      ...claim,
      isDuplicate: false,
      subjectEntityId,
      subjectEmbedding: null,
      claimEmbedding: claimEmbedded.embedding,
      batchEntityKey: null,
      contradictionCandidate: candidate
    };
  }

  // Новая (ещё не существующая) сущность не может иметь существующих claims —
  // проверка на дубль claim'а не нужна, экономим вызов.
  const claimEmbedded = await embedText(buildClaimText(claim));
  costTracker.value += claimEmbedded.costUsd;
  return {
    ...claim,
    isDuplicate: false,
    subjectEntityId: null,
    subjectEmbedding: subjectEmbedded.embedding,
    claimEmbedding: claimEmbedded.embedding,
    batchEntityKey: normalizeKey(claim.subject),
    contradictionCandidate: null
  };
}

async function resolveEntity({ db, judgeDuplicate, claim, subjectEmbedding, costTracker }) {
  const { data: candidates, error } = await db.rpc('match_entities', {
    query_embedding: subjectEmbedding,
    match_threshold: SIMILARITY_THRESHOLD
  });

  if (error || !candidates || candidates.length === 0) {
    return null;
  }

  const top = candidates[0];
  try {
    const verdict = await judgeDuplicate({ kind: 'entity', new: claim.subject, candidate: top.name });
    costTracker.value += verdict.costUsd;
    return verdict.isDuplicate ? top.id : null;
  } catch (err) {
    // judgeDuplicate прикрепляет costUsd к ошибке, если OpenRouter уже
    // списал деньги за вызов до того, как парсинг ответа модели упал —
    // эта уже потраченная сумма не должна теряться вместе с исключением.
    costTracker.value += err.costUsd ?? 0;
    throw err;
  }
}

async function resolveClaimDuplicate({ db, judgeDuplicate, claim, claimEmbedding, subjectEntityId, costTracker }) {
  const { data: candidates, error } = await db.rpc('match_claims', {
    query_embedding: claimEmbedding,
    match_threshold: SIMILARITY_THRESHOLD,
    for_subject_entity_id: subjectEntityId
  });

  if (error || !candidates || candidates.length === 0) {
    return { candidate: null, isDuplicate: false };
  }

  const top = candidates[0];
  try {
    const verdict = await judgeDuplicate({
      kind: 'claim',
      new: buildClaimText(claim),
      candidate: `${top.predicate}: ${top.object_value ?? ''}`
    });
    costTracker.value += verdict.costUsd;
    return { candidate: top, isDuplicate: verdict.isDuplicate };
  } catch (err) {
    costTracker.value += err.costUsd ?? 0;
    throw err;
  }
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
