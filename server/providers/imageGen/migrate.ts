import fs from 'fs';
import type Database from 'better-sqlite3';

const AUDIT_FIELDS = ['gen_provider', 'provider_request_id', 'provider_route_reason', 'provider_error'] as const;

export function migrateImageProviderAudit(db: Database.Database, migrationSqlPath: string): { shotsUpdated: number } {
  db.exec(fs.readFileSync(migrationSqlPath, 'utf8'));
  const row = db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get() as { value: string } | undefined;
  if (!row) return { shotsUpdated: 0 };
  const scripts = JSON.parse(row.value);
  let shotsUpdated = 0;
  for (const script of scripts || []) {
    for (const shot of script.newShots || []) {
      let changed = false;
      for (const field of AUDIT_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(shot, field)) {
          shot[field] = null;
          changed = true;
        }
      }
      if (changed) shotsUpdated += 1;
    }
  }
  if (shotsUpdated) {
    db.prepare("INSERT OR REPLACE INTO store (key, value) VALUES ('generated_scripts', ?)").run(JSON.stringify(scripts));
  }
  console.log('[ImageProviderMigration]', JSON.stringify({ timestamp: new Date().toISOString(), shots_updated: shotsUpdated }));
  return { shotsUpdated };
}
