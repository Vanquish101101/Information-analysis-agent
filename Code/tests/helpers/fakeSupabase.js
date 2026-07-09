// tests/helpers/fakeSupabase.js

// Minimal fake for the subset of the Supabase query-builder chain this
// project uses: .from(table).select().eq().order().limit() / .single()
// and .from(table).insert(payload) / .update(payload).eq() — both read and
// write chains are thenables, matching real supabase-js: `await query`
// resolves to `{ data, error }` without an explicit `.then()` call.
// `state.operation` ('select' | 'insert' | 'update') and `state.payload` let
// a test's handler distinguish which operation is in progress.
// `db.schema(name)` records the requested schema in `db.schemaCalls` and
// returns the same fake client (tables are looked up by name only, not by
// schema) — enough for tests to assert the caller requested the right
// cross-schema client, which is the exact bug this fake exists to catch
// (see agent1Reader.js/agent2Reader.js: real supabase-js silently resolves
// .from() against the client's default schema when .schema() is omitted).
export function makeFakeDb(handlers) {
  const db = {
    schemaCalls: [],
    schema(name) {
      db.schemaCalls.push(name);
      return db;
    },
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
    },
    rpc(name, params) {
      const handler = handlers[name];
      if (!handler) {
        throw new Error(`makeFakeDb: no RPC handler registered for "${name}"`);
      }
      return Promise.resolve(handler(params));
    }
  };
  return db;
}
