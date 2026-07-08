import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/db/migrations/004_cost_columns.sql'
);
const sql = readFileSync(migrationPath, 'utf8');

test('adds cost_usd_retry column to runs', () => {
  assert.match(sql, /ALTER TABLE information_analysis_agent\.runs/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS cost_usd_retry\s+NUMERIC\(10,\s*4\)\s+NOT NULL DEFAULT 0/);
});

test('adds cost_usd_analysis column to runs', () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS cost_usd_analysis\s+NUMERIC\(10,\s*4\)\s+NOT NULL DEFAULT 0/);
});
