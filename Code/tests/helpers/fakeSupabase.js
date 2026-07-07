// tests/helpers/fakeSupabase.js

// Minimal fake for the subset of the Supabase query-builder chain this
// project uses: .from(table).select().eq().order().limit() / .single()
// The real supabase-js query builder is a thenable — `await query` resolves
// to `{ data, error }` without calling `.then()` explicitly. This fake
// mirrors that so reader code doesn't need to know it's under test.
export function makeFakeDb(handlers) {
  return {
    from(table) {
      const state = { table, filters: {} };
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
