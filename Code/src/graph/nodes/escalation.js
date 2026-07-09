// src/graph/nodes/escalation.js

const LOW_CONFIDENCE = 'низкая';
const RETRY_COST_THRESHOLD_USD = 0.10;
const RETRY_COST_CAP_USD = 5;

// Предварительные оценки — калибруются по факту, не архитектурное решение.
// video намеренно дороже порога: по ТЗ такие ретраи чаще должны
// эскалироваться пользователю, а не выполняться автоматически.
const CONTENT_TYPE_RETRY_COST_ESTIMATES = {
  video: 0.15,
  audio: 0.05,
  document: 0.03,
  image: 0.02,
  text: 0.01
};

export function createEscalationNode({ db, retryParse }) {
  return async function escalationNode(state) {
    const resolvedItems = [];
    const pendingDecisions = [];
    let costUsdRetry = 0;
    let escalationsAuto = 0;
    let escalationsPendingUser = 0;
    let costCapReached = false;

    for (const item of state.items) {
      if (item.confidence?.level !== LOW_CONFIDENCE) {
        resolvedItems.push(item);
        continue;
      }

      if (!item.content_ref) {
        pendingDecisions.push(buildPendingDecision(item, 'Повтор невозможен: нет content_ref (результат поиска, не парсинга)'));
        escalationsPendingUser += 1;
        resolvedItems.push(item);
        continue;
      }

      if (costUsdRetry >= RETRY_COST_CAP_USD) {
        costCapReached = true;
        pendingDecisions.push(buildPendingDecision(item, 'Достигнут лимит трат на автоповторы за прогон ($5)'));
        escalationsPendingUser += 1;
        resolvedItems.push(item);
        continue;
      }

      const estimatedCost = CONTENT_TYPE_RETRY_COST_ESTIMATES[item.content_type] ?? RETRY_COST_THRESHOLD_USD;
      if (estimatedCost > RETRY_COST_THRESHOLD_USD) {
        pendingDecisions.push(buildPendingDecision(
          item,
          `Ожидаемая стоимость повтора $${estimatedCost} превышает порог $${RETRY_COST_THRESHOLD_USD}`,
          estimatedCost
        ));
        escalationsPendingUser += 1;
        resolvedItems.push(item);
        continue;
      }

      try {
        const retried = await retryParse({ contentRef: item.content_ref, contentType: item.content_type });
        costUsdRetry += retried.meta?.cost_usd ?? 0;
        escalationsAuto += 1;
        resolvedItems.push({ ...item, result: retried.result, confidence: retried.confidence });
      } catch (err) {
        pendingDecisions.push(buildPendingDecision(item, `Автоповтор не удался: ${err.message}`));
        escalationsPendingUser += 1;
        resolvedItems.push(item);
      }
    }

    for (const decision of pendingDecisions) {
      const { error } = await db.from('pending_user_decisions').insert(decision);
      if (error) {
        console.error('escalation: failed to record pending_user_decisions row:', error.message);
      }
    }

    return {
      items: resolvedItems,
      escalationsAuto,
      escalationsPendingUser,
      costUsdRetry,
      costCapReached
    };
  };
}

function buildPendingDecision(item, question, estimatedCostUsd = null) {
  return {
    job_id: item.job_id,
    question,
    estimated_cost_usd: estimatedCostUsd
  };
}
