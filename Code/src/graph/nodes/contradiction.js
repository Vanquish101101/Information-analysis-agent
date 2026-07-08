// src/graph/nodes/contradiction.js
import { Overwrite } from '@langchain/langgraph';

const HIGH_CONFIDENCE = 'высокая';
const SELF_CONSISTENCY_SAMPLES = 3;

export function createContradictionNode({ judgeContradiction }) {
  return async function contradictionNode(state) {
    const resolvedClaims = [];
    const newErrors = [];

    for (const claim of state.claims) {
      if (!claim.contradictionCandidate) {
        resolvedClaims.push(claim);
        continue;
      }

      try {
        resolvedClaims.push(await resolveContradiction({ judgeContradiction, claim }));
      } catch (err) {
        newErrors.push(`contradiction check failed for claim subject "${claim.subject}": ${err.message}`);
        resolvedClaims.push({ ...claim, hasContradiction: false });
      }
    }

    return {
      claims: new Overwrite(resolvedClaims),
      errors: newErrors
    };
  };
}

async function resolveContradiction({ judgeContradiction, claim }) {
  const candidate = claim.contradictionCandidate;
  const newClaimText = buildClaimText(claim);
  const existingClaimText = `${candidate.predicate}: ${candidate.object_value ?? ''}`;

  const sampleCount = candidate.confidence_level === HIGH_CONFIDENCE ? SELF_CONSISTENCY_SAMPLES : 1;
  const verdicts = [];
  for (let i = 0; i < sampleCount; i += 1) {
    verdicts.push(await judgeContradiction({ newClaimText, existingClaimText }));
  }

  const rawLabel = majorityLabel(verdicts.map((v) => v.label));

  if (rawLabel === 'agree') {
    return { ...claim, hasContradiction: false };
  }

  const primary = verdicts[0];
  return {
    ...claim,
    hasContradiction: true,
    contradictsClaimId: candidate.id,
    contradictionRawLabel: rawLabel,
    contradictionConfidenceLevel: primary.confidenceLevel,
    contradictionExplanation: primary.explanation
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
