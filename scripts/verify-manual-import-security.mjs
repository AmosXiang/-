import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import sharp from 'sharp';

const backend = process.env.BACKEND_URL || 'http://127.0.0.1:3002';
const comfy = process.env.COMFYUI_API_URL || 'http://127.0.0.1:8001';
const db = new Database(path.resolve('db.sqlite'));
const source = process.env.SOURCE_TASK_ID
  ? db.prepare("SELECT * FROM comfyui_tasks WHERE id = ? AND status = 'succeeded'").get(process.env.SOURCE_TASK_ID)
  : db.prepare(`
      SELECT * FROM comfyui_tasks
      WHERE status = 'succeeded' AND uiWorkflowJson IS NOT NULL AND uiWorkflowJson != ''
        AND targetType = 'shot' AND viewType = 'main' AND origin = 'queue'
      ORDER BY COALESCE(completedAt, createdAt) DESC, createdAt DESC, rowid DESC LIMIT 1
    `).get();
if (!source) throw new Error('No source task found.');

const artifactDir = path.resolve('test-artifacts', 'security');
fs.mkdirSync(artifactDir, { recursive: true });

async function exportedWorkflow() {
  const response = await fetch(`${backend}/api/comfyui/tasks/${source.id}/export-workflow`);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function makeRealPng(label, mutateUi = () => {}, metadataPadding = '') {
  const ui = await exportedWorkflow();
  mutateUi(ui);
  if (metadataPadding) ui.extra.securityTestPadding = metadataPadding;
  const api = JSON.parse(source.apiWorkflowJson);
  const saveNode = Object.values(api).find(node => node.class_type === 'SaveImage');
  saveNode.inputs.filename_prefix = `story-bank/security-${label}-${Date.now()}`;
  const submitted = await fetch(`${comfy}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: api, client_id: crypto.randomUUID(), extra_data: { extra_pnginfo: { workflow: ui } } }),
  });
  const body = await submitted.json();
  if (!submitted.ok || !body.prompt_id) throw new Error(`ComfyUI rejected ${label}: ${JSON.stringify(body)}`);
  let image;
  for (let i = 0; i < 120; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const history = await (await fetch(`${comfy}/history/${body.prompt_id}`)).json();
    const record = history[body.prompt_id];
    if (record?.status?.status_str === 'error') throw new Error(`${label} generation failed`);
    image = Object.values(record?.outputs || {}).flatMap(output => output.images || [])[0];
    if (image) break;
  }
  if (!image) throw new Error(`${label} generation timed out`);
  const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output' });
  const response = await fetch(`${comfy}/view?${query}`);
  const outputPath = path.join(artifactDir, `${label}.png`);
  fs.writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
  return outputPath;
}

async function upload(filePath, filename = path.basename(filePath), force = false) {
  const form = new FormData();
  form.append('file', await fs.openAsBlob(filePath), filename);
  const response = await fetch(`${backend}/api/comfyui/tasks/${source.id}/import-result${force ? '?force=true' : ''}`, { method: 'POST', body: form });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

function currentSlotUrl() {
  const scripts = JSON.parse(db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get().value);
  const project = scripts.find(item => String(item.id) === String(source.projectId));
  return project.newShots.find(item => String(item.id) === String(source.targetId)).imageUrl;
}

const baselineUrl = currentSlotUrl();
const baselineImports = db.prepare("SELECT COUNT(*) count FROM comfyui_tasks WHERE origin = 'manual_import'").get().count;
const results = [];
async function expectRejected(name, filePath, expectedStatus = 422, filename) {
  const result = await upload(filePath, filename);
  const unchanged = currentSlotUrl() === baselineUrl;
  const importCount = db.prepare("SELECT COUNT(*) count FROM comfyui_tasks WHERE origin = 'manual_import'").get().count;
  const passed = result.status === expectedStatus && unchanged && importCount === baselineImports;
  results.push({ name, passed, status: result.status, error: result.body.error, oldImageUnchanged: unchanged, noTaskCreated: importCount === baselineImports });
  if (!passed) throw new Error(`${name} failed: ${JSON.stringify(results.at(-1))}`);
}

const ordinary = path.join(artifactDir, 'ordinary.png');
await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toFile(ordinary);
await expectRejected('ordinary PNG without metadata', ordinary);

const wrongMapping = await makeRealPng('wrong-mapping', ui => {
  ui.extra.aiVideoWorkbench.parameterNodeIds.positivePrompt = '999999';
});
await expectRejected('wrong explicit node mapping', wrongMapping);

const wrongSlot = await makeRealPng('wrong-slot', ui => {
  ui.extra.aiVideoWorkbench.targetId = 'forged-other-slot';
});
await expectRejected('wrong target slot provenance', wrongSlot);

const valid = await makeRealPng('valid-corruption-source');
const validBuffer = fs.readFileSync(valid);
const badCrc = path.join(artifactDir, 'bad-crc.png');
const badCrcBuffer = Buffer.from(validBuffer);
badCrcBuffer[badCrcBuffer.length - 1] ^= 0xff;
fs.writeFileSync(badCrc, badCrcBuffer);
await expectRejected('corrupted PNG chunk CRC', badCrc);

const badTextCrc = path.join(artifactDir, 'bad-text-crc.png');
const badTextBuffer = Buffer.from(validBuffer);
const workflowTextOffset = badTextBuffer.indexOf(Buffer.from('workflow\0'));
if (workflowTextOffset < 0) throw new Error('Real ComfyUI PNG has no workflow tEXt chunk.');
badTextBuffer[workflowTextOffset + 'workflow\0'.length + 16] ^= 0x31;
fs.writeFileSync(badTextCrc, badTextBuffer);
await expectRejected('corrupted workflow metadata CRC', badTextCrc);

const truncated = path.join(artifactDir, 'truncated.png');
fs.writeFileSync(truncated, validBuffer.subarray(0, validBuffer.length - 9));
await expectRejected('truncated PNG chunk', truncated);

const compressedCorrupt = path.join(artifactDir, 'corrupt-compressed-data.png');
const compressedBuffer = Buffer.from(validBuffer);
compressedBuffer[Math.floor(compressedBuffer.length * 0.7)] ^= 0x5a;
fs.writeFileSync(compressedCorrupt, compressedBuffer);
await expectRejected('corrupted compressed PNG data', compressedCorrupt);

const invalidZtxt = path.resolve('node_modules/streampng-v2/test/pngs/suite/broken/ztxt_data_format.png');
await expectRejected('abnormal compressed zTXt metadata', invalidZtxt);

const fake = path.join(artifactDir, 'fake.png');
fs.writeFileSync(fake, 'not a png');
await expectRejected('forged .png extension', fake);

const oversized = path.join(artifactDir, 'oversized.png');
fs.writeFileSync(oversized, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
fs.truncateSync(oversized, 50 * 1024 * 1024 + 1);
await expectRejected('file over 50MB', oversized, 413);

const largeMetadata = await makeRealPng('metadata-over-limit', () => {}, 'x'.repeat(5 * 1024 * 1024 + 1024));
await expectRejected('metadata over 5MB', largeMetadata);

const targetDir = path.dirname(path.resolve(`.${source.imageUrl}`));
const beforeTemps = new Set(fs.readdirSync(targetDir).filter(name => name.startsWith('.comfy-import-')));
await new Promise(resolve => {
  const boundary = `----codex-${crypto.randomUUID()}`;
  const request = http.request(`${backend}/api/comfyui/tasks/${source.id}/import-result`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Transfer-Encoding': 'chunked' },
  });
  request.on('error', () => resolve());
  request.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="interrupted.png"\r\nContent-Type: image/png\r\n\r\n`);
  request.write(validBuffer.subarray(0, Math.min(validBuffer.length, 4096)));
  setTimeout(() => request.destroy(), 25);
  setTimeout(resolve, 250);
});
await new Promise(resolve => setTimeout(resolve, 300));
const afterTemps = fs.readdirSync(targetDir).filter(name => name.startsWith('.comfy-import-') && !beforeTemps.has(name));
results.push({ name: 'interrupted upload temp cleanup', passed: afterTemps.length === 0, remainingTempFiles: afterTemps });
if (afterTemps.length) throw new Error(`Interrupted upload left temp files: ${afterTemps.join(', ')}`);

console.log(JSON.stringify({ sourceTaskId: source.id, baselineUrl, results }, null, 2));
