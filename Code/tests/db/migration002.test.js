// tests/db/migration002.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/db/migrations/002_dedup_match_functions.sql'
);
const sql = readFileSync(migrationPath, 'utf8');

test('creates match_entities function with the expected parameters', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION information_analysis_agent\.match_entities/);
  assert.match(sql, /query_embedding vector\(768\)/);
  assert.match(sql, /match_threshold float/);
});

test('creates match_claims function with the expected parameters', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION information_analysis_agent\.match_claims/);
  assert.match(sql, /for_subject_entity_id uuid/);
});

test('match_claims returns confidence_explanation (needed to build the bumped explanation text)', () => {
  const claimsBlock = sql.split('match_claims')[1];
  assert.match(claimsBlock, /confidence_explanation/);
});

test('both functions filter on a similarity threshold using the <=> operator', () => {
  const occurrences = sql.match(/<=>/g) ?? [];
  assert.ok(occurrences.length >= 4, `expected at least 4 uses of <=> (2 per function: SELECT + WHERE/ORDER), found ${occurrences.length}`);
});
