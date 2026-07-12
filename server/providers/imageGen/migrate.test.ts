import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrateImageProviderAudit } from './migrate.ts';

const sqlPath = path.resolve('migrations/001_add_image_provider_audit.sql');

function databaseWithShot(shot: Record<string, unknown>) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE store (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO store (key, value) VALUES (?, ?)').run('generated_scripts', JSON.stringify([{ id: 'p1', newShots: [{ id: 's1', ...shot }] }]));
  return db;
}

test('migration adds audit fields when task A fields are absent', () => {
  const db = databaseWithShot({ description: 'empty room' });
  const first = migrateImageProviderAudit(db, sqlPath);
  const second = migrateImageProviderAudit(db, sqlPath);
  const scripts = JSON.parse((db.prepare("SELECT value FROM store WHERE key='generated_scripts'").get() as any).value);
  assert.equal(first.shotsUpdated, 1);
  assert.equal(second.shotsUpdated, 0);
  assert.equal(scripts[0].newShots[0].gen_provider, null);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shot_image_provider_audit'").get());
  db.close();
});

test('migration preserves task A camera fields when already present', () => {
  const db = databaseWithShot({ isMaster: true, cameraH: 'front', cameraV: 'eye', cameraZoom: 'medium' });
  migrateImageProviderAudit(db, sqlPath);
  const scripts = JSON.parse((db.prepare("SELECT value FROM store WHERE key='generated_scripts'").get() as any).value);
  assert.equal(scripts[0].newShots[0].isMaster, true);
  assert.equal(scripts[0].newShots[0].cameraH, 'front');
  assert.equal(scripts[0].newShots[0].gen_provider, null);
  db.close();
});
