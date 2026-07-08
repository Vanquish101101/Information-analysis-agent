import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/db/migrations/003_contradictions.sql'
);
const sql = readFileSync(migrationPath, 'utf8');

test('creates the contradictions table with the expected columns', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS information_analysis_agent\.contradictions/);
  assert.match(sql, /claim_a_id\s+UUID NOT NULL REFERENCES information_analysis_agent\.claims\(id\)/);
  assert.match(sql, /claim_b_id\s+UUID NOT NULL REFERENCES information_analysis_agent\.claims\(id\)/);
  assert.match(sql, /detected_at\s+TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
});

test('label is constrained to contradict or unclear', () => {
  const tableBlock = sql.split('CREATE TABLE')[1];
  assert.match(tableBlock, /label\s+TEXT NOT NULL CHECK \(label IN \('contradict', 'unclear'\)\)/);
});

test('confidence_level is constrained to the three-value vocabulary', () => {
  const tableBlock = sql.split('CREATE TABLE')[1];
  assert.match(tableBlock, /confidence_level\s+TEXT NOT NULL CHECK \(confidence_level IN \('высокая', 'средняя', 'низкая'\)\)/);
});

test('grants access and disables RLS, matching the other tables in this schema', () => {
  assert.match(sql, /GRANT ALL ON information_analysis_agent\.contradictions TO anon, authenticated, service_role/);
  assert.match(sql, /ALTER TABLE information_analysis_agent\.contradictions DISABLE ROW LEVEL SECURITY/);
});

test('indexes both claim id columns', () => {
  assert.match(sql, /CREATE INDEX IF NOT EXISTS contradictions_claim_a_idx ON information_analysis_agent\.contradictions\(claim_a_id\)/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS contradictions_claim_b_idx ON information_analysis_agent\.contradictions\(claim_b_id\)/);
});
