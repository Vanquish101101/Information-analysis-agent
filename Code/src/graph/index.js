// src/graph/index.js
import { StateGraph, START, END } from '@langchain/langgraph';
import { AnalysisState } from './state.js';
import { dispatchToExtraction } from './nodes/dispatcher.js';
import { createExtractClaimsNode } from './nodes/extractClaims.js';
import { reducerNode } from './nodes/reducer.js';
import { createPersistResultsNode } from './nodes/persistResults.js';

export function createAnalysisGraph({ db, extractClaims } = {}) {
  if (!db) {
    throw new Error('createAnalysisGraph: db is required');
  }
  if (typeof extractClaims !== 'function') {
    throw new Error('createAnalysisGraph: extractClaims must be a function');
  }

  const extractClaimsNode = createExtractClaimsNode(extractClaims);
  const persistResultsNode = createPersistResultsNode({ db });

  const compiledGraph = new StateGraph(AnalysisState)
    .addNode('extractClaims', extractClaimsNode)
    .addNode('reducer', reducerNode)
    .addNode('persistResults', persistResultsNode)
    .addConditionalEdges(START, dispatchToExtraction)
    .addEdge('extractClaims', 'reducer')
    .addEdge('reducer', 'persistResults')
    .addEdge('persistResults', END)
    .compile();

  return async function runAnalysis(items, { reason } = {}) {
    const result = await compiledGraph.invoke({ items, reason: reason ?? null });
    return {
      runId: result.runId,
      status: result.status,
      claimsWritten: result.claims.length,
      errors: result.errors
    };
  };
}
