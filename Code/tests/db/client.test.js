import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseClient } from '../../src/db/client.js';

test('createSupabaseClient throws when url is missing', () => {
  assert.throws(
    () => createSupabaseClient({ serviceKey: 'fake-key' }),
    /url and serviceKey are required/
  );
});

test('createSupabaseClient throws when serviceKey is missing', () => {
  assert.throws(
    () => createSupabaseClient({ url: 'https://example.supabase.co' }),
    /url and serviceKey are required/
  );
});

test('createSupabaseClient returns a usable client when config is valid', () => {
  const client = createSupabaseClient({
    url: 'https://example.supabase.co',
    serviceKey: 'fake-key'
  });
  assert.equal(typeof client.from, 'function');
});
