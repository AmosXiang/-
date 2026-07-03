import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import sharp from 'sharp';

const port = process.env.PORT || '3013';
const db = new Database(process.env.SQLITE_DB_PATH || 'db.sqlite');
await import('../server.ts');
await new Promise(resolve => setTimeout(resolve, 800));

try {
  const batch = db.prepare(`SELECT b.id FROM comfyui_shot_batches b WHERE EXISTS (SELECT 1 FROM comfyui_shot_batch_items i WHERE i.batchId = b.id) ORDER BY b.createdAt DESC LIMIT 1`).get();
  if (!batch) throw new Error('No shot batch with persisted items is available');
  const response = await fetch(`http://127.0.0.1:${port}/api/comfyui/shot-batches/${batch.id}/report`, { method: 'POST' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  for (const url of [result.reportJsonUrl, result.reportHtmlUrl, result.contactSheetUrl]) {
    const filePath = path.resolve(url.replace(/^\/uploads\//, 'uploads/'));
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) throw new Error(`Missing report artifact: ${filePath}`);
  }
  const contactPath = path.resolve(result.contactSheetUrl.replace(/^\/uploads\//, 'uploads/'));
  const metadata = await sharp(contactPath).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Contact sheet is not a valid image');
  console.log(JSON.stringify({ status: 'PASS', batchId: batch.id, summary: result.summary, contactSheet: { width: metadata.width, height: metadata.height }, urls: result }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  db.close();
  setTimeout(() => process.exit(process.exitCode || 0), 50);
}
