// src/graph/nodes/notifications.js

const HIGH_CONFIDENCE = 'высокая';

export function createNotificationsNode({ sendNotification }) {
  return async function notificationsNode(state) {
    const pendingDecisions = state.pendingDecisionMessages ?? [];
    const contradictions = (state.claims ?? []).filter(
      (claim) => claim.hasContradiction && claim.contradictedClaimHistoricalConfidence === HIGH_CONFIDENCE
    );
    const costCapReached = state.costCapReached ?? false;

    if (pendingDecisions.length === 0 && contradictions.length === 0 && !costCapReached) {
      return {};
    }

    const message = buildMessage({ pendingDecisions, contradictions, costCapReached });

    try {
      await sendNotification(message);
    } catch (err) {
      console.error('notifications: failed to send Telegram notification:', err.message);
    }

    return {};
  };
}

function buildMessage({ pendingDecisions, contradictions, costCapReached }) {
  const sections = [];

  if (costCapReached) {
    sections.push('⚠️ Достигнут лимит трат на автоповторы за прогон ($5) — дальнейшие автоповторы остановлены.');
  }

  if (pendingDecisions.length > 0) {
    const lines = pendingDecisions.map(
      (d) => `• ${d.question}${d.estimated_cost_usd != null ? ` (≈$${d.estimated_cost_usd})` : ''}`
    );
    sections.push(`📋 Требуют решения (${pendingDecisions.length}):\n${lines.join('\n')}`);
  }

  if (contradictions.length > 0) {
    const lines = contradictions.map(
      (c) => `• ${c.subject}: ${c.predicate}: ${c.object_value ?? ''} — ${c.contradictionExplanation ?? 'противоречит устоявшемуся факту'}`
    );
    sections.push(`⚡ Противоречия с устоявшимися фактами (${contradictions.length}):\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}
