import { Send } from '@langchain/langgraph';

// Пустой items[] (например, FORCED_CEILING без накопленных элементов) не должен
// давать ноль Send — иначе reducer/persistResults вообще не выполнятся, и прогон
// не попадёт в runs. Проверено напрямую на установленной версии @langchain/langgraph.
export function dispatchToExtraction(state) {
  if (state.items.length === 0) {
    return ['reducer'];
  }
  return state.items.map((item) => new Send('extractClaims', { item }));
}
