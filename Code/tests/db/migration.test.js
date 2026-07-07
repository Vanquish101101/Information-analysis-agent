// tests/db/migration.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/db/migrations/001_information_analysis_agent_schema.sql'
);
const sql = readFileSync(migrationPath, 'utf8');

test('migration creates all five required tables', () => {
  for (const table of ['entities', 'sources', 'claims', 'runs', 'pending_user_decisions']) {
    assert.match(
      sql,
      new RegExp(`CREATE TABLE IF NOT EXISTS information_analysis_agent\\.${table}`)
    );
  }
});

test('claims table uses subject_entity_id/object_entity_id, not subject_id/object_id', () => {
  const claimsBlock = sql
    .split('CREATE TABLE IF NOT EXISTS information_analysis_agent.claims')[1]
    .split('CREATE TABLE')[0];
  assert.match(claimsBlock, /subject_entity_id/);
  assert.match(claimsBlock, /object_entity_id/);
  assert.doesNotMatch(claimsBlock, /\bsubject_id\b/);
  assert.doesNotMatch(claimsBlock, /\bobject_id\b/);
});

test('claims and entities both have a pgvector embedding column', () => {
  const claimsBlock = sql
    .split('CREATE TABLE IF NOT EXISTS information_analysis_agent.claims')[1]
    .split('CREATE TABLE')[0];
  const entitiesBlock = sql
    .split('CREATE TABLE IF NOT EXISTS information_analysis_agent.entities')[1]
    .split('CREATE TABLE')[0];
  assert.match(claimsBlock, /embedding\s+vector/);
  assert.match(entitiesBlock, /embedding\s+vector/);
});

test('pending_user_decisions has estimated_cost_usd column', () => {
  assert.match(sql, /estimated_cost_usd/);
});

test('confidence_level has a CHECK constraint restricting to the three Russian levels', () => {
  assert.match(sql, /confidence_level[\s\S]*?CHECK[\s\S]*?высокая[\s\S]*?средняя[\s\S]*?низкая/);
});
