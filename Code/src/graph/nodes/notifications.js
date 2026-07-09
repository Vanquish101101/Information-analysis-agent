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

// Развёрнутый, повествовательный формат (не сухой техотчёт) — по
// требованию пользователя после живого смоук-теста Слайса 10. Пока это
// только уведомление, без интерактивного разрешения (выбор варианта
// действия + расчёт стоимости повтора перед подтверждением пользователя —
// отдельная будущая доработка, когда бот станет полноценно интерактивным),
// поэтому явно оговаривается в самом сообщении.
function buildMessage({ pendingDecisions, contradictions, costCapReached }) {
  const sections = ['🤖 Агент 3 закончил очередной прогон анализа.'];

  sections.push('Не всё удалось обработать полностью автоматически — нужна ваша помощь:');

  if (pendingDecisions.length > 0) {
    const lines = pendingDecisions.map(
      (d, i) => `${i + 1}. ${d.question}${d.estimated_cost_usd != null ? ` (≈$${d.estimated_cost_usd})` : ''}`
    );
    sections.push(`📋 Требуют решения (${pendingDecisions.length}):\n${lines.join('\n')}`);
  }

  if (costCapReached) {
    sections.push('⚠️ Достигнут лимит трат на автоповторы за этот прогон ($5) — дальнейшие автоповторы в этом прогоне остановлены.');
  }

  if (contradictions.length > 0) {
    const lines = contradictions.map(
      (c, i) => `${i + 1}. Новый факт «${c.subject}: ${c.predicate}: ${c.object_value ?? ''}» противоречит ранее подтверждённому факту — ${c.contradictionExplanation ?? 'причина не указана'}.`
    );
    sections.push(`⚡ Противоречия с устоявшимися фактами (${contradictions.length}):\n${lines.join('\n')}`);
  }

  sections.push('Что дальше: это сообщение просто информирует вас о найденных проблемах — автоматического способа «ответить» на них прямо в Telegram пока нет (появится в будущих доработках).');

  return sections.join('\n\n');
}
