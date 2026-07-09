// src/graph/index.js
import { StateGraph, START, END } from '@langchain/langgraph';
import { AnalysisState } from './state.js';
import { createEscalationNode } from './nodes/escalation.js';
import { dispatchToExtraction } from './nodes/dispatcher.js';
import { createExtractClaimsNode } from './nodes/extractClaims.js';
import { reducerNode } from './nodes/reducer.js';
import { createDedupNode } from './nodes/dedup.js';
import { createContradictionNode } from './nodes/contradiction.js';
import { createPersistResultsNode } from './nodes/persistResults.js';
import { createGlobalSynthesisNode } from './nodes/globalSynthesis.js';
import { createNotificationsNode } from './nodes/notifications.js';

export function createAnalysisGraph({ db, extractClaims, embedText, judgeDuplicate, judgeContradiction, retryParse, synthesizeDigest, sendNotification, notifyAgent4 } = {}) {
  if (!db) {
    throw new Error('createAnalysisGraph: db is required');
  }
  if (typeof extractClaims !== 'function') {
    throw new Error('createAnalysisGraph: extractClaims must be a function');
  }
  if (typeof embedText !== 'function') {
    throw new Error('createAnalysisGraph: embedText must be a function');
  }
  if (typeof judgeDuplicate !== 'function') {
    throw new Error('createAnalysisGraph: judgeDuplicate must be a function');
  }
  if (typeof judgeContradiction !== 'function') {
    throw new Error('createAnalysisGraph: judgeContradiction must be a function');
  }
  if (typeof retryParse !== 'function') {
    throw new Error('createAnalysisGraph: retryParse must be a function');
  }
  if (typeof synthesizeDigest !== 'function') {
    throw new Error('createAnalysisGraph: synthesizeDigest must be a function');
  }
  if (typeof sendNotification !== 'function') {
    throw new Error('createAnalysisGraph: sendNotification must be a function');
  }

  const escalationNode = createEscalationNode({ db, retryParse });
  const extractClaimsNode = createExtractClaimsNode(extractClaims);
  const dedupNode = createDedupNode({ db, embedText, judgeDuplicate });
  const contradictionNode = createContradictionNode({ judgeContradiction });
  const persistResultsNode = createPersistResultsNode({ db });
  const globalSynthesisNode = createGlobalSynthesisNode({ db, synthesizeDigest, notifyAgent4 });
  const notificationsNode = createNotificationsNode({ sendNotification });

  const compiledGraph = new StateGraph(AnalysisState)
    .addNode('escalation', escalationNode)
    .addNode('extractClaims', extractClaimsNode)
    .addNode('reducer', reducerNode)
    .addNode('dedup', dedupNode)
    .addNode('contradiction', contradictionNode)
    .addNode('persistResults', persistResultsNode)
    .addNode('globalSynthesis', globalSynthesisNode)
    .addNode('notifications', notificationsNode)
    .addEdge(START, 'escalation')
    .addConditionalEdges('escalation', dispatchToExtraction)
    .addEdge('extractClaims', 'reducer')
    .addEdge('reducer', 'dedup')
    .addEdge('dedup', 'contradiction')
    .addEdge('contradiction', 'persistResults')
    .addEdge('persistResults', 'globalSynthesis')
    .addEdge('globalSynthesis', 'notifications')
    .addEdge('notifications', END)
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
