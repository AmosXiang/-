import { spawn } from 'node:child_process';
import fs from 'node:fs';

const port = 3003;
const base = `http://127.0.0.1:${port}`;
const projectId = '1783192733645';
const targetId = 'b7f47f57-9cf0-4fbd-a893-420af0925cb3';
const comfy = spawn('C:\\Users\\Owner\\Documents\\ComfyUI\\.venv\\Scripts\\python.exe', ['main.py', '--port', '8001'], {
  cwd: 'C:\\Users\\Owner\\Documents\\ComfyUI', windowsHide: true, env: process.env,
});
let comfyLog = '';
comfy.stdout.on('data', chunk => { comfyLog += chunk; });
comfy.stderr.on('data', chunk => { comfyLog += chunk; });
const server = spawn('C:\\Program Files\\nodejs\\node.exe', ['node_modules/tsx/dist/cli.mjs', 'server.ts'], {
  cwd: process.cwd(), windowsHide: true, env: { ...process.env, PORT: String(port) },
});
let serverLog = '';
server.stdout.on('data', chunk => { serverLog += chunk; process.stdout.write(chunk); });
server.stderr.on('data', chunk => { serverLog += chunk; process.stderr.write(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function json(path, options) {
  const response = await fetch(`${base}${path}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
  return body;
}

try {
  for (let i = 0; i < 180; i += 1) {
    try { const response = await fetch('http://127.0.0.1:8001/system_stats'); if (response.ok) break; } catch {}
    if (i === 179) throw new Error(`ComfyUI startup timeout: ${comfyLog.slice(-2000)}`);
    await sleep(1000);
  }
  for (let i = 0; i < 45; i += 1) {
    try { await json('/api/generated-scripts'); break; } catch { if (i === 44) throw new Error('server startup timeout'); await sleep(1000); }
  }
  const submission = await json('/api/generate-image', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      presetId: 'qwen_2511_three_views', platform: 'comfyui', projectId,
      targetType: 'character', targetId, viewType: 'front', characterName: '艾丽莎',
      sourceImageUrl: '/uploads/projects/1783192733645/characters/character/comfyui-f7cb971aa08fff76eeab7242be063afffbf8002508a814f1c3aa11d929f3d8d9.png',
      sourceTaskId: 'd23a8bda-f8af-4ea2-9d94-fe9082e022cb',
    }),
  });
  console.log('[P0-6:Submission]', JSON.stringify(submission));
  const taskIds = submission.taskIds;
  let tasks = [];
  for (let i = 0; i < 900; i += 1) {
    const response = await json(`/api/comfyui/tasks?projectId=${projectId}`);
    tasks = (response.tasks || response).filter(task => taskIds.includes(task.id));
    console.log('[P0-6:Poll]', JSON.stringify(tasks.map(task => ({ id: task.id, viewType: task.viewType, status: task.status, stateDetail: task.stateDetail, error: task.error }))));
    if (tasks.length === 3 && tasks.every(task => ['succeeded', 'failed', 'cancelled'].includes(task.status))) break;
    await sleep(2000);
  }
  const report = { timestamp: new Date().toISOString(), submission, tasks };
  fs.writeFileSync('p0-6-acceptance.json', JSON.stringify(report, null, 2));
  fs.writeFileSync('p0-6-server.log', serverLog);
  fs.writeFileSync('p0-6-comfyui.log', comfyLog);
  if (tasks.length !== 3 || tasks.some(task => task.status !== 'succeeded')) process.exitCode = 1;
} finally {
  server.kill();
  comfy.kill();
}
