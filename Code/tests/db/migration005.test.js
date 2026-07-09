import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/db/migrations/005_digest.sql'
);
const sql = readFileSync(migrationPath, 'utf8');

test('creates the claim_sources junction table with a composite primary key', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS information_analysis_agent\.claim_sources/);
  assert.match(sql, /claim_id\s+UUID NOT NULL REFERENCES information_analysis_agent\.claims\(id\)/);
  assert.match(sql, /source_id\s+UUID NOT NULL REFERENCES information_analysis_agent\.sources\(id\)/);
  assert.match(sql, /PRIMARY KEY \(claim_id, source_id\)/);
});

test('adds reach_estimate column to sources, defaulting to 0', () => {
  assert.match(sql, /ALTER TABLE information_analysis_agent\.sources/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS reach_estimate\s+NUMERIC NOT NULL DEFAULT 0/);
});

test('creates the digests table with facts/contradictions/meta JSONB columns', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS information_analysis_agent\.digests/);
  assert.match(sql, /run_id\s+UUID NOT NULL REFERENCES information_analysis_agent\.runs\(id\)/);
  assert.match(sql, /facts\s+JSONB NOT NULL DEFAULT '\[\]'/);
  assert.match(sql, /contradictions\s+JSONB NOT NULL DEFAULT '\[\]'/);
  assert.match(sql, /meta\s+JSONB NOT NULL DEFAULT '\{\}'/);
});

test('creates the claim_source_stats RPC function returning claim_id/sources_count/reach_estimate', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION information_analysis_agent\.claim_source_stats/);
  assert.match(sql, /RETURNS TABLE \(claim_id uuid, sources_count bigint, reach_estimate numeric\)/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION information_analysis_agent\.claim_source_stats TO anon, authenticated, service_role/);
});
