// src/graph/state.js
import { Annotation } from '@langchain/langgraph';

function concatReducer(a, b) {
  return a.concat(b);
}

function sumReducer(a, b) {
  return a + b;
}

export const AnalysisState = Annotation.Root({
  items: Annotation(),
  reason: Annotation(),
  runId: Annotation(),
  status: Annotation(),
  claims: Annotation({
    reducer: concatReducer,
    default: () => []
  }),
  errors: Annotation({
    reducer: concatReducer,
    default: () => []
  }),
  costUsdAnalysis: Annotation({
    reducer: sumReducer,
    default: () => 0
  }),
  costUsdRetry: Annotation(),
  escalationsAuto: Annotation(),
  escalationsPendingUser: Annotation(),
  costCapReached: Annotation(),
  persistedFacts: Annotation(),
  persistedContradictions: Annotation(),
  pendingDecisionMessages: Annotation()
});
