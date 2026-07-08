// src/scheduler/stateStore.js

export function createInMemoryStateStore() {
  const store = new Map();
  return {
    get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    set(key, value) {
      store.set(key, value);
    }
  };
}
