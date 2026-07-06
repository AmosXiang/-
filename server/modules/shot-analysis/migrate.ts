// 模块内迁移执行器:按文件名顺序应用 migrations/*.sql,
// 应用记录登记在 shot_analysis_migrations 表,保证幂等。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

type DatabaseInstance = Database.Database;

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export function applyShotAnalysisMigrations(db: DatabaseInstance, logger: Pick<Console, 'log'> = console): void {
  db.exec('CREATE TABLE IF NOT EXISTS shot_analysis_migrations (name TEXT PRIMARY KEY, appliedAt TEXT NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT name FROM shot_analysis_migrations').all() as Array<{ name: string }>).map(row => row.name),
  );
  const files = fs.readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort();
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf8');
    const run = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO shot_analysis_migrations (name, appliedAt) VALUES (?, ?)').run(name, new Date().toISOString());
    });
    run();
    logger.log(`[ShotAnalysis:Migration] Applied ${name}`);
  }
}
