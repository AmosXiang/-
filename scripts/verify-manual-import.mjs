import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const backend = process.env.BACKEND_URL || 'http://127.0.0.1:3002';
const comfy = process.env.COMFYUI_API_URL || 'http://127.0.0.1:8001';
const db = new Database(path.resolve('db.sqlite'));
const source = process.env.SOURCE_TASK_ID
  ? db.prepare("SELECT * FROM comfyui_tasks WHERE id = ? AND status = 'succeeded'").get(process.env.SOURCE_TASK_ID)
  : db.prepare(`
      SELECT * FROM comfyui_tasks
      WHERE status = 'succeeded' AND uiWorkflowJson IS NOT NULL AND uiWorkflowJson != ''
      ORDER BY COALESCE(completedAt, createdAt) DESC, createdAt DESC, rowid DESC LIMIT 1
    `).get();
if (!source) throw new Error('No succeeded task with a UI workflow is available.');

const exportResponse = await fetch(`${backend}/api/comfyui/tasks/${source.id}/export-workflow`);
if (!exportResponse.ok) throw new Error(`Workflow export failed: ${await exportResponse.text()}`);
const uiWorkflow = await exportResponse.json();
const ids = uiWorkflow.extra.aiVideoWorkbench.parameterNodeIds;
const apiWorkflow = JSON.parse(source.apiWorkflowJson);
const marker = `manual-import-real-${Date.now()}`;
const seed = String((BigInt(source.seed) + 1729n) % 9007199254740991n);
apiWorkflow[ids.positivePrompt].inputs.text = `${source.prompt}, ${marker}`;
apiWorkflow[ids.sampler].inputs.seed = Number(seed);
const uiNodes = new Map(uiWorkflow.nodes.map(node => [String(node.id), node]));
uiNodes.get(ids.positivePrompt).widgets_values[0] = apiWorkflow[ids.positivePrompt].inputs.text;
uiNodes.get(ids.sampler).widgets_values[0] = Number(seed);

const submitted = await fetch(`${comfy}/prompt`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: apiWorkflow,
    client_id: crypto.randomUUID(),
    extra_data: { extra_pnginfo: { workflow: uiWorkflow } },
  }),
});
const submitBody = await submitted.json();
if (!submitted.ok || !submitBody.prompt_id) throw new Error(`ComfyUI rejected workflow: ${JSON.stringify(submitBody)}`);

let output;
for (let attempt = 0; attempt < 240; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  const history = await (await fetch(`${comfy}/history/${submitBody.prompt_id}`)).json();
  const record = history[submitBody.prompt_id];
  if (record?.status?.status_str === 'error') throw new Error(`ComfyUI failed: ${JSON.stringify(record.status.messages)}`);
  output = Object.values(record?.outputs || {}).flatMap(item => item.images || [])[0];
  if (output) break;
}
if (!output) throw new Error('Timed out waiting for real ComfyUI PNG.');

const artifactDir = path.resolve('test-artifacts');
fs.mkdirSync(artifactDir, { recursive: true });
const realPng = path.join(artifactDir, `manual-import-${source.id}.png`);
const viewQuery = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder || '', type: output.type || 'output' });
const pngResponse = await fetch(`${comfy}/view?${viewQuery}`);
if (!pngResponse.ok) throw new Error(`Could not download ComfyUI PNG: ${pngResponse.status}`);
fs.writeFileSync(realPng, Buffer.from(await pngResponse.arrayBuffer()));

if (process.env.GENERATE_ONLY === 'true') {
  console.log(JSON.stringify({ sourceTaskId: source.id, comfyPromptId: submitBody.prompt_id, realPng, marker, seed }, null, 2));
  process.exit(0);
}

async function upload(force = false) {
  const form = new FormData();
  form.append('file', await fs.openAsBlob(realPng), path.basename(realPng));
  const response = await fetch(`${backend}/api/comfyui/tasks/${source.id}/import-result${force ? '?force=true' : ''}`, { method: 'POST', body: form });
  return { status: response.status, body: await response.json() };
}

let first = await upload(false);
if (first.status === 409) first = await upload(true);
if (first.status !== 201 && !(first.status === 200 && first.body.duplicate)) {
  throw new Error(`Real PNG import failed (${first.status}): ${JSON.stringify(first.body)}`);
}
const second = await upload(true);
if (second.status !== 200 || !second.body.duplicate || second.body.taskId !== first.body.taskId) {
  throw new Error(`Idempotency failed: ${JSON.stringify({ first, second })}`);
}

const imported = db.prepare('SELECT * FROM comfyui_tasks WHERE id = ?').get(first.body.taskId);
const duplicateCount = db.prepare(`
  SELECT COUNT(*) count FROM comfyui_tasks
  WHERE origin = 'manual_import' AND importedFromTaskId = ? AND importSha256 = ?
`).get(source.id, imported.importSha256).count;
const exportedAgain = await fetch(`${backend}/api/comfyui/tasks/${imported.id}/export-workflow`);
if (!exportedAgain.ok) throw new Error(`Imported task re-export failed: ${await exportedAgain.text()}`);
const reExportedWorkflow = await exportedAgain.json();
if (reExportedWorkflow.extra.aiVideoWorkbench.sourceTaskId !== imported.id) {
  throw new Error('Re-export did not bind provenance to the imported task.');
}
const reloadResponse = await fetch(`${comfy}/prompt`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: JSON.parse(imported.apiWorkflowJson),
    client_id: crypto.randomUUID(),
    extra_data: { extra_pnginfo: { workflow: reExportedWorkflow } },
  }),
});
const reloadBody = await reloadResponse.json();
if (!reloadResponse.ok || !reloadBody.prompt_id) throw new Error(`ComfyUI could not load re-exported workflow: ${JSON.stringify(reloadBody)}`);
let reloadSucceeded = false;
for (let attempt = 0; attempt < 120; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 500));
  const history = await (await fetch(`${comfy}/history/${reloadBody.prompt_id}`)).json();
  const record = history[reloadBody.prompt_id];
  if (record?.status?.status_str === 'error') throw new Error(`Re-exported workflow failed in ComfyUI: ${JSON.stringify(record.status.messages)}`);
  if (Object.values(record?.outputs || {}).some(item => (item.images || []).length > 0)) {
    reloadSucceeded = true;
    break;
  }
}
if (!reloadSucceeded) throw new Error('Re-exported workflow did not produce an image in ComfyUI.');

console.log(JSON.stringify({
  sourceTaskId: source.id,
  comfyPromptId: submitBody.prompt_id,
  realPng,
  importedTaskId: imported.id,
  oldImageUrl: source.imageUrl,
  newImageUrl: imported.imageUrl,
  parameters: {
    prompt: imported.prompt,
    negativePrompt: imported.negativePrompt,
    seed: imported.seed,
    model: imported.model,
    width: imported.width,
    height: imported.height,
  },
  idempotency: { duplicateCount, sameTaskId: second.body.taskId === imported.id },
  reExportSourceTaskId: reExportedWorkflow.extra.aiVideoWorkbench.sourceTaskId,
  reExportComfyPromptId: reloadBody.prompt_id,
  reExportLoadedSuccessfully: reloadSucceeded,
}, null, 2));
