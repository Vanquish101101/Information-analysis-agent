// src/graph/nodes/contradiction.js
import { Overwrite } from '@langchain/langgraph';

const HIGH_CONFIDENCE = 'высокая';
const SELF_CONSISTENCY_SAMPLES = 3;

export function createContradictionNode({ judgeContradiction }) {
  return async function contradictionNode(state) {
    const resolvedClaims = [];
    const newErrors = [];
    let costUsdAnalysis = 0;

    for (const claim of state.claims) {
      if (!claim.contradictionCandidate) {
        resolvedClaims.push(claim);
        continue;
      }

      // costTracker переживает исключение из resolveContradiction: если
      // самоконсистентность делает 3 сэмпла и первый успел стоить денег,
      // а второй бросил исключение, уже понесённая стоимость первого всё
      // равно попадёт в costUsdAnalysis через finally, а не потеряется.
      const costTracker = { value: 0 };
      try {
        const resolvedClaim = await resolveContradiction({ judgeContradiction, claim, costTracker });
        resolvedClaims.push(resolvedClaim);
      } catch (err) {
        newErrors.push(`contradiction check failed for claim subject "${claim.subject}": ${err.message}`);
        resolvedClaims.push({ ...claim, hasContradiction: false });
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

async function resolveContradiction({ judgeContradiction, claim, costTracker }) {
  const candidate = claim.contradictionCandidate;
  const newClaimText = buildClaimText(claim);
  const existingClaimText = `${candidate.predicate}: ${candidate.object_value ?? ''}`;

  const sampleCount = candidate.confidence_level === HIGH_CONFIDENCE ? SELF_CONSISTENCY_SAMPLES : 1;
  const verdicts = [];
  for (let i = 0; i < sampleCount; i += 1) {
    try {
      const verdict = await judgeContradiction({ newClaimText, existingClaimText });
      verdicts.push(verdict);
      costTracker.value += verdict.costUsd;
    } catch (err) {
      // judgeContradiction прикрепляет costUsd к ошибке, если OpenRouter уже
      // списал деньги за этот сэмпл до того, как парсинг ответа модели упал.
      costTracker.value += err.costUsd ?? 0;
      throw err;
    }
  }

  const rawLabel = majorityLabel(verdicts.map((v) => v.label));

  if (rawLabel === 'agree') {
    return { ...claim, hasContradiction: false };
  }

  const primary = verdicts.find((v) => v.label === rawLabel) ?? verdicts[0];
  return {
    ...claim,
    hasContradiction: true,
    contradictsClaimId: candidate.id,
    contradictionRawLabel: rawLabel,
    contradictionConfidenceLevel: primary.confidenceLevel,
    contradictionExplanation: primary.explanation,
    contradictedClaimHistoricalConfidence: candidate.confidence_level
  };
}

function majorityLabel(labels) {
  const counts = {};
  for (const label of labels) {
    counts[label] = (counts[label] ?? 0) + 1;
  }

  const isThreeWayTie = labels.length === 3 && Object.keys(counts).length === 3;
  if (isThreeWayTie) {
    return 'unclear';
  }

  let winner = labels[0];
  let winnerCount = 0;
  for (const [label, count] of Object.entries(counts)) {
    if (count > winnerCount) {
      winner = label;
      winnerCount = count;
    }
  }
  return winner;
}

function buildClaimText(claim) {
  return `${claim.subject}: ${claim.predicate}: ${claim.object_value ?? ''}`;
}
