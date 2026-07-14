import Database from 'better-sqlite3';

function arg(name: string, fallback = ''): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const db = new Database(arg('db', 'db.sqlite'));
const projectId = arg('project');
const masterShotId = arg('mark-master');
if (projectId && masterShotId) {
  const row = db.prepare("SELECT value FROM store WHERE key='generated_scripts'").get() as { value: string };
  const scripts = JSON.parse(row.value);
  const script = scripts.find((item: any) => String(item.id) === projectId);
  const shot = script?.newShots?.find((item: any) => String(item.id) === masterShotId);
  if (!shot) throw new Error('Requested master shot was not found.');
  shot.isMaster = true;
  db.prepare("UPDATE store SET value=? WHERE key='generated_scripts'").run(JSON.stringify(scripts));
  console.log(JSON.stringify({ event: 'master_marked', project_id: projectId, shot_id: masterShotId }));
}
const columns = db.prepare('PRAGMA table_info(shot_image_provider_audit)').all();
const rows = db.prepare('SELECT * FROM shot_image_provider_audit ORDER BY updated_at').all();
console.log(JSON.stringify({ columns, rows }, null, 2));
db.close();
