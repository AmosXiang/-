import assert from 'node:assert/strict';
import fs from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { buildRecipeFingerprint } from '../../providers/imageGen/recipeFingerprint.ts';

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function writeScripts(dbPath: string, scripts: any[]) {
  const db = new Database(dbPath);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare("INSERT INTO store (key, value) VALUES ('generated_scripts', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(scripts));
  } finally {
    db.close();
  }
}

function readScripts(dbPath: string): any[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get() as { value: string };
    return JSON.parse(row.value);
  } finally {
    db.close();
  }
}

async function waitForServer(baseUrl: string, child: ChildProcess, logs: () => string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited before readiness.\n${logs()}`);
    try {
      const response = await fetch(`${baseUrl}/api/generated-scripts`);
      if (response.ok) return;
    } catch {
      // The isolated server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Server readiness timed out.\n${logs()}`);
}

async function json(response: Response): Promise<any> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'style-gate-p2-acceptance-'));
const uploadsDir = path.join(tempRoot, 'uploads');
const dbPath = path.join(tempRoot, 'db.sqlite');
const formalDbPath = path.join(process.cwd(), 'db.sqlite');
const formalUploadsPath = path.join(process.cwd(), 'uploads');
const formalDbWasAbsent = !fs.existsSync(formalDbPath);
const formalUploadsWereAbsent = !fs.existsSync(formalUploadsPath);
let child: ChildProcess | null = null;
let stdout = '';
let stderr = '';

try {
  fs.mkdirSync(path.join(uploadsDir, 'p2'), { recursive: true });
  const shotAPath = path.join(uploadsDir, 'p2', 'shot-a.png');
  const shotBPath = path.join(uploadsDir, 'p2', 'shot-b.png');
  await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 230, g: 25, b: 25 } } }).png().toFile(shotAPath);
  await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 25, g: 25, b: 230 } } }).png().toFile(shotBPath);

  const baseRecipe = buildRecipeFingerprint({
    provider: 'agnes',
    model: 'agnes-image-2.1-flash',
    workflowPresetId: null,
    styleContractVersion: 2,
    styleAnchorVersion: 3,
    params: { width: 1280, height: 720, loraStrength: 0.8 },
  });
  const driftRecipe = buildRecipeFingerprint({
    provider: 'agnes',
    model: 'agnes-image-2.1-flash',
    workflowPresetId: null,
    styleContractVersion: 2,
    styleAnchorVersion: 3,
    params: { width: 1280, height: 720, loraStrength: 0.65 },
  });
  const commonShot = {
    timestamp: '00:00',
    durationSec: 3,
    description: 'P2 acceptance shot',
    optimizedPrompt: 'P2 acceptance shot',
    camera: { move: 'static', speed: 'slow' },
    framing: { shotSize: 'wide', angle: 'eye-level' },
    gen_style_contract_version: 2,
    gen_style_anchor_version: 3,
  };
  writeScripts(dbPath, [{
    id: 'p2-acceptance',
    newTitle: 'P2 Acceptance',
    newNarrative: {},
    newCharacters: [],
    styleContract: {
      version: 2,
      locked: true,
      updatedAt: '2026-07-18T00:00:00.000Z',
      storyboardPresetId: 'p2-test',
      styleOverlay: 'manual review',
      width: 1280,
      height: 720,
      loraStrength: 0.8,
    },
    styleAnchor: { imageUrl: '/uploads/style-anchors/p2-acceptance-3.png', version: 3, updatedAt: '2026-07-18T00:00:00.000Z' },
    newShots: [
      { ...commonShot, id: 'shot-a', generatedImageUrl: '/uploads/p2/shot-a.png', gen_recipe: baseRecipe },
      { ...commonShot, id: 'shot-b', generatedImageUrl: '/uploads/p2/shot-b.png', gen_recipe: driftRecipe },
    ],
  }]);

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      SQLITE_DB_PATH: dbPath,
      UPLOADS_DIR: uploadsDir,
      DISABLE_COMFY_WORKER: 'true',
      COMFYUI_AUTOSTART: 'false',
      COMFYUI_MANAGED_LAUNCH_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', chunk => { stdout += String(chunk); });
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  await waitForServer(baseUrl, child, () => `${stdout}\n${stderr}`);

  await json(await fetch(`${baseUrl}/api/projects/p2-acceptance/approved-recipe`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shotId: 'shot-a' }),
  }));
  for (const shotId of ['shot-a', 'shot-b']) {
    await json(await fetch(`${baseUrl}/api/generated-scripts/p2-acceptance/shots/${shotId}/style-approved`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    }));
  }

  const initial = await json(await fetch(`${baseUrl}/api/generated-scripts/p2-acceptance/delivery-check`));
  const initialA = initial.styleGate.details.find((item: any) => item.shotId === 'shot-a');
  const initialB = initial.styleGate.details.find((item: any) => item.shotId === 'shot-b');
  assert.equal(initialA.recipeMatches, true);
  assert.equal(initialB.recipeMatches, false);
  assert.equal(initial.styleGate.recipeDrift, 1);
  assert.equal(initial.styleGate.undecodable, 0);
  assert.equal(initial.styleGate.unapproved, 0);

  const persisted = readScripts(dbPath)[0];
  assert.equal(persisted.approvedRecipe.fingerprint, baseRecipe.fingerprint);
  assert.equal(persisted.newShots[0].styleApproved.approvedFingerprint, baseRecipe.fingerprint);
  assert.equal(persisted.newShots[1].styleApproved.approvedFingerprint, driftRecipe.fingerprint);

  persisted.styleContract.version = 3;
  writeScripts(dbPath, [persisted]);
  const contractChanged = await json(await fetch(`${baseUrl}/api/generated-scripts/p2-acceptance/delivery-check`));
  assert.equal(contractChanged.styleGate.contractStale, 2);

  fs.rmSync(shotBPath);
  const imageRemoved = await json(await fetch(`${baseUrl}/api/generated-scripts/p2-acceptance/delivery-check`));
  assert.equal(imageRemoved.styleGate.undecodable, 1);
  assert.equal(imageRemoved.styleGate.details.find((item: any) => item.shotId === 'shot-b').imageDecodable, false);

  console.log(JSON.stringify({
    approvedFingerprint: baseRecipe.fingerprint,
    driftFingerprint: driftRecipe.fingerprint,
    recipeMatches: { shotA: initialA.recipeMatches, shotB: initialB.recipeMatches },
    recipeDrift: initial.styleGate.recipeDrift,
    styleApprovalsPersisted: true,
    contractStaleAfterVersionChange: contractChanged.styleGate.contractStale,
    undecodableAfterImageRemoval: imageRemoved.styleGate.undecodable,
    colorOutlierWarningOnly: initial.styleGate.colorOutliers,
    realProviderCalls: 0,
    formalWorkspaceDbUntouched: formalDbWasAbsent && !fs.existsSync(formalDbPath),
    formalWorkspaceUploadsUntouched: formalUploadsWereAbsent && !fs.existsSync(formalUploadsPath),
  }, null, 2));
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    if (!await waitForExit(child, 5_000) && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      await waitForExit(child, 5_000);
    }
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
