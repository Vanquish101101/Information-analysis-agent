// src/graph/state.js
import { Annotation } from '@langchain/langgraph';

function concatReducer(a, b) {
  return a.concat(b);
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
  })
});
