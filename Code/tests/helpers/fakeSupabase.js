// tests/helpers/fakeSupabase.js

// Minimal fake for the subset of the Supabase query-builder chain this
// project uses: .from(table).select().eq().order().limit() / .single()
// and .from(table).insert(payload) / .update(payload).eq() — both read and
// write chains are thenables, matching real supabase-js: `await query`
// resolves to `{ data, error }` without an explicit `.then()` call.
// `state.operation` ('select' | 'insert' | 'update') and `state.payload` let
// a test's handler distinguish which operation is in progress.
export function makeFakeDb(handlers) {
  return {
    from(table) {
      const state = { table, filters: {}, operation: 'select', payload: undefined };
      const resolve = () => {
        const handler = handlers[table];
        if (!handler) {
          throw new Error(`makeFakeDb: no handler registered for table "${table}"`);
        }
        return Promise.resolve(handler(state));
      };
      const builder = {
        select() {
          return builder;
        },
        eq(column, value) {
          state.filters[column] = value;
          return builder;
        },
        order() {
          return builder;
        },
        limit() {
          return builder;
        },
        insert(payload) {
          state.operation = 'insert';
          state.payload = payload;
          return builder;
        },
        update(payload) {
          state.operation = 'update';
          state.payload = payload;
          return builder;
        },
        single() {
          return resolve();
        },
        then(onFulfilled, onRejected) {
          return resolve().then(onFulfilled, onRejected);
        }
      };
      return builder;
    }
  };
}
