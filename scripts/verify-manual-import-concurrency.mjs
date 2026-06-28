import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import Database from 'better-sqlite3';

const backend = new URL(process.env.BACKEND_URL || 'http://127.0.0.1:3002');
const db = new Database(path.resolve('db.sqlite'));
const source = process.env.SOURCE_TASK_ID
  ? db.prepare("SELECT * FROM comfyui_tasks WHERE id = ? AND status = 'succeeded'").get(process.env.SOURCE_TASK_ID)
  : db.prepare(`
      SELECT * FROM comfyui_tasks
      WHERE status = 'succeeded' AND uiWorkflowJson IS NOT NULL AND uiWorkflowJson != ''
        AND targetType = 'shot' AND viewType = 'main' AND origin = 'queue'
      ORDER BY COALESCE(completedAt, createdAt) DESC, createdAt DESC, rowid DESC LIMIT 1
    `).get();
const pngPath = path.resolve(process.env.TEST_PNG || 'test-artifacts/security/valid-corruption-source.png');
if (!source || !fs.existsSync(pngPath)) throw new Error('Source task or real test PNG is missing.');

const boundary = `----codex-race-${Date.now()}`;
const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="race.png"\r\nContent-Type: image/png\r\n\r\n`);
const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
const png = fs.readFileSync(pngPath);

let responseResolve;
const responsePromise = new Promise(resolve => { responseResolve = resolve; });
const request = http.request({
  hostname: backend.hostname,
  port: backend.port,
  path: `/api/comfyui/tasks/${source.id}/import-result`,
  method: 'POST',
  headers: {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': header.length + png.length + footer.length,
  },
}, response => {
  const chunks = [];
  response.on('data', chunk => chunks.push(chunk));
  response.on('end', () => responseResolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
});
request.on('error', error => responseResolve({ status: 0, body: { error: error.message } }));
request.write(header);

let offset = 0;
const chunkSize = 16 * 1024;
const uploadTimer = setInterval(() => {
  if (offset >= png.length) {
    clearInterval(uploadTimer);
    request.end(footer);
    return;
  }
  request.write(png.subarray(offset, Math.min(offset + chunkSize, png.length)));
  offset += chunkSize;
}, 150);

await new Promise(resolve => setTimeout(resolve, 300));
const generationResponse = await fetch(new URL('/api/generate-image', backend), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: `${source.prompt}, concurrency-newer-${Date.now()}`,
    negativePrompt: source.negativePrompt,
    seedMode: 'random',
    model: source.model,
    width: source.width,
    height: source.height,
    projectId: source.projectId,
    targetType: source.targetType,
    targetId: source.targetId,
    viewType: source.viewType,
    shotIndex: source.shotIndex,
    platform: 'comfyui',
    skipTranslation: true,
  }),
});
const generation = await generationResponse.json();
if (!generationResponse.ok) throw new Error(`Could not create newer task: ${JSON.stringify(generation)}`);
let newerTask;
for (let i = 0; i < 120; i += 1) {
  await new Promise(resolve => setTimeout(resolve, 250));
  newerTask = db.prepare('SELECT * FROM comfyui_tasks WHERE id = ?').get(generation.taskId);
  if (newerTask?.status === 'succeeded') break;
  if (newerTask?.status === 'failed') throw new Error(`Newer task failed: ${newerTask.error}`);
}
if (newerTask?.status !== 'succeeded') throw new Error('Newer task did not succeed during upload.');

const staleResult = await responsePromise;
if (staleResult.status !== 409 || staleResult.body.code !== 'STALE_SOURCE') {
  throw new Error(`Expected transaction-time 409, got ${JSON.stringify(staleResult)}`);
}
const form = new FormData();
form.append('file', await fs.openAsBlob(pngPath), path.basename(pngPath));
const forceResponse = await fetch(new URL(`/api/comfyui/tasks/${source.id}/import-result?force=true`, backend), { method: 'POST', body: form });
const forceResult = await forceResponse.json();
if (forceResponse.status !== 201) throw new Error(`Force retry failed: ${JSON.stringify(forceResult)}`);

const imported = db.prepare('SELECT * FROM comfyui_tasks WHERE id = ?').get(forceResult.taskId);
console.log(JSON.stringify({
  sourceTaskId: source.id,
  newerTaskId: newerTask.id,
  staleUpload: staleResult,
  forcedImportTaskId: imported.id,
  oldImageUrl: newerTask.imageUrl,
  forcedImageUrl: imported.imageUrl,
}, null, 2));
