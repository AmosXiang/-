import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3';
import { registerImageGenRouting } from './routes.ts';
import { migrateImageProviderAudit } from './migrate.ts';
import type { ImageStyleContext } from './styleBundle.ts';
import type { ImageGenProvider, ImageGenRequest, ImageGenResult } from './types.ts';

const migrationSqlPath = path.resolve('migrations/001_add_image_provider_audit.sql');

function overwriteConfig(file: string, autoRoute: boolean): void {
  fs.writeFileSync(file, JSON.stringify({
    autoRoute,
    rules: [
      { name: 'master_frame_local', if: { isMaster: true }, provider: 'comfyui_local' },
      { name: 'has_character_local', if: { hasCharacter: true }, provider: 'comfyui_local' },
      { name: 'default_agnes', if: {}, provider: 'agnes' },
    ],
  }));
}

function writeConfig(autoRoute: boolean): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'imageGenRouting-')), 'imageGenRouting.json');
  overwriteConfig(file, autoRoute);
  return file;
}

function advanceMtime(file: string, offsetSeconds: number): void {
  const next = new Date(Date.now() + offsetSeconds * 1000);
  fs.utimesSync(file, next, next);
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE store (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO store (key, value) VALUES (?, ?)').run('generated_scripts', JSON.stringify([{
    id: 'p1',
    newShots: [
      { id: 's1', description: 'empty street at dawn' },
      { id: 's2', description: 'hero close-up', matchedCharacterIds: ['c1'] },
    ],
  }]));
  migrateImageProviderAudit(db, migrationSqlPath);
  return db;
}

class StubAgnesProvider implements ImageGenProvider {
  readonly name = 'agnes' as const;
  calls: ImageGenRequest[] = [];
  behavior: (req: ImageGenRequest) => Promise<ImageGenResult> = async req => ({
    provider: 'agnes',
    requestId: `stub-${this.calls.length}`,
    imagePath: `/uploads/images/agnes/shot-${req.shotId}-stub.png`,
    seedUsed: undefined,
    rawMeta: { remote_url: 'https://example.invalid/img.png' },
  });

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    this.calls.push(req);
    return this.behavior(req);
  }
}

async function startApp(options: {
  autoRoute: boolean;
  stub?: StubAgnesProvider;
  db?: Database.Database;
  optimizePrompt?: (prompt: string, isCharacter: boolean, style?: string) => Promise<string>;
  resolveStyleContext?: (projectId: string, shotId: string) => ImageStyleContext | null;
}) {
  const db = options.db ?? makeDb();
  const stub = options.stub ?? new StubAgnesProvider();
  const legacyCalls: any[] = [];
  const app = express();
  const configPath = writeConfig(options.autoRoute);
  app.use(express.json());
  registerImageGenRouting({
    app,
    db,
    uploadsDir: os.tmpdir(),
    configPath,
    optimizePrompt: options.optimizePrompt ?? (async prompt => prompt),
    resolveStyleContext: options.resolveStyleContext,
    createAgnesProvider: () => stub,
  });
  app.post('/api/generate-image', (req, res) => {
    legacyCalls.push(req.body);
    res.json({ taskId: 'legacy-task-1' });
  });
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const post = async (body: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { db, stub, legacyCalls, configPath, post, close: () => new Promise(resolve => server.close(resolve)) };
}

function readShot(db: Database.Database, shotId: string): Record<string, any> {
  const row = db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get() as { value: string };
  const scripts = JSON.parse(row.value);
  return scripts[0].newShots.find((shot: any) => String(shot.id) === shotId);
}

function writeShotStyleVersion(db: Database.Database, shotId: string, version: number): void {
  const row = db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get() as { value: string };
  const scripts = JSON.parse(row.value);
  const shot = scripts[0].newShots.find((item: any) => String(item.id) === shotId);
  shot.gen_style_contract_version = version;
  db.prepare("UPDATE store SET value = ? WHERE key = 'generated_scripts'").run(JSON.stringify(scripts));
}

// 真实 App.tsx 请求体:普通空镜生成(handleGenerateShotImage 形状)。
const normalEmptyShotBody = {
  presetId: 'shot_default',
  prompt: 'empty street at dawn',
  negativePrompt: 'low quality',
  platform: 'comfyui',
  projectId: 'p1',
  targetType: 'shot',
  targetId: 's1',
  viewType: 'main',
  shotIndex: 0,
};

const styleContext: ImageStyleContext = {
  contractVersion: 0,
  styleOverlay: 'cinematic teal rain',
  sceneId: 'scene-1',
  sceneOverlay: 'wet neon station platform',
  width: 1280,
  height: 720,
  presetId: '01_klein_character_master',
  loraStrength: 0.65,
};

test('autoRoute off: normal empty-shot generation passes through to the legacy handler untouched', async () => {
  const ctx = await startApp({ autoRoute: false });
  try {
    const { status, body } = await ctx.post(normalEmptyShotBody);
    assert.equal(status, 200);
    assert.equal(body.taskId, 'legacy-task-1');
    assert.equal(ctx.stub.calls.length, 0);
    assert.equal(ctx.legacyCalls.length, 1);
    assert.equal(ctx.legacyCalls[0].platform, 'comfyui');
  } finally {
    await ctx.close();
  }
});

test('routing config hot reloads on mtime change and keeps the last valid config after invalid JSON', async () => {
  const ctx = await startApp({ autoRoute: false });
  try {
    const before = await ctx.post(normalEmptyShotBody);
    assert.equal(before.body.taskId, 'legacy-task-1');
    assert.equal(ctx.stub.calls.length, 0);

    overwriteConfig(ctx.configPath, true);
    advanceMtime(ctx.configPath, 2);
    const after = await ctx.post(normalEmptyShotBody);
    assert.equal(after.body.provider, 'agnes');
    assert.equal(ctx.stub.calls.length, 1);

    fs.writeFileSync(ctx.configPath, '{ invalid JSON');
    advanceMtime(ctx.configPath, 4);
    const afterInvalidConfig = await ctx.post(normalEmptyShotBody);
    assert.equal(afterInvalidConfig.status, 200);
    assert.equal(afterInvalidConfig.body.provider, 'agnes');
    assert.equal(ctx.stub.calls.length, 2);
  } finally {
    await ctx.close();
  }
});

test('upscale requests bypass provider routing even with autoRoute on', async () => {
  const ctx = await startApp({ autoRoute: true });
  try {
    // 真实 App.tsx 请求体:handleUpscaleImage(无 prompt,带 sourceImageUrl)。
    const { status, body } = await ctx.post({
      presetId: '04_esrgan_upscale',
      platform: 'comfyui',
      projectId: 'p1',
      targetType: 'shot',
      targetId: 's1',
      viewType: 'main',
      sourceImageUrl: '/uploads/images/existing.png',
      shotIndex: 0,
    });
    assert.equal(status, 200);
    assert.equal(body.taskId, 'legacy-task-1');
    assert.equal(ctx.stub.calls.length, 0);
  } finally {
    await ctx.close();
  }
});

test('autoRoute on: advanced-adjust style request for a character shot stays on ComfyUI and returns taskId', async () => {
  const ctx = await startApp({ autoRoute: true });
  try {
    const { status, body } = await ctx.post({
      prompt: 'hero close-up',
      platform: 'comfyui',
      skipTranslation: true,
      projectId: 'p1',
      targetType: 'shot',
      targetId: 's2',
      viewType: 'main',
      shotIndex: 1,
    });
    assert.equal(status, 200);
    assert.equal(body.taskId, 'legacy-task-1');
    assert.equal(ctx.stub.calls.length, 0);
  } finally {
    await ctx.close();
  }
});

test('forceProvider=agnes routes synchronously and records audit even with autoRoute off', async () => {
  const ctx = await startApp({ autoRoute: false });
  try {
    const { status, body } = await ctx.post({ ...normalEmptyShotBody, forceProvider: 'agnes', width: 1024, height: 1024 });
    assert.equal(status, 200);
    assert.equal(body.provider, 'agnes');
    assert.ok(body.imageUrl);
    assert.equal(ctx.stub.calls.length, 1);
    const audit = ctx.db.prepare('SELECT * FROM shot_image_provider_audit WHERE project_id = ? AND shot_id = ?').get('p1', 's1') as any;
    assert.equal(audit.gen_provider, 'agnes');
    assert.equal(audit.provider_error, null);
  } finally {
    await ctx.close();
  }
});

test('Agnes consumes the shared bundle after prompt optimization and records version-zero provenance', async () => {
  const stub = new StubAgnesProvider();
  stub.behavior = async req => ({
    provider: 'agnes',
    requestId: 'stub-style-bundle',
    imagePath: `/uploads/images/agnes/shot-${req.shotId}-style-bundle.png`,
    seedUsed: undefined,
    rawMeta: {
      remote_url: 'https://example.invalid/style-bundle.png',
      oversized: 'x'.repeat(9000),
    },
  });
  const ctx = await startApp({
    autoRoute: false,
    stub,
    optimizePrompt: async prompt => `optimized: ${prompt}`,
    resolveStyleContext: () => styleContext,
  });
  try {
    const { status, body } = await ctx.post({ ...normalEmptyShotBody, forceProvider: 'agnes' });
    assert.equal(status, 200);
    assert.equal(body.styleContractVersion, 0);
    assert.equal(stub.calls.length, 1);
    assert.deepEqual(stub.calls[0], {
      shotId: 0,
      prompt: [
        'optimized: empty street at dawn',
        'Project art direction style overlay (style only; preserve shot content and composition): cinematic teal rain',
        'Scene reference (environment only; preserve shot content, composition and characters): wet neon station platform',
      ].join('\n\n'),
      width: 1280,
      height: 720,
      seed: undefined,
      referenceImages: undefined,
    });

    const shot = readShot(ctx.db, 's1');
    assert.equal(shot.gen_style_contract_version, 0);
    const audit = ctx.db.prepare('SELECT * FROM shot_image_provider_audit WHERE project_id = ? AND shot_id = ?').get('p1', 's1') as any;
    assert.ok(Buffer.byteLength(audit.raw_meta) <= 8192);
    const rawMeta = JSON.parse(audit.raw_meta);
    assert.equal(rawMeta.providerRawMetaTruncated, true);
    assert.deepEqual(rawMeta.styleBundle, {
      contractVersion: 0,
      sceneId: 'scene-1',
      styleOverlayLen: 'cinematic teal rain'.length,
      sceneOverlayLen: 'wet neon station platform'.length,
      width: 1280,
      height: 720,
      presetId: '01_klein_character_master',
      loraStrength: 0.65,
      injected: { style: true, scene: true },
    });
  } finally {
    await ctx.close();
  }
});

test('explicit Agnes dimensions override the bundle dimensions', async () => {
  const ctx = await startApp({
    autoRoute: false,
    resolveStyleContext: () => ({ ...styleContext, contractVersion: 4 }),
  });
  try {
    const { status } = await ctx.post({
      ...normalEmptyShotBody,
      forceProvider: 'agnes',
      width: 640,
      height: 384,
    });
    assert.equal(status, 200);
    assert.equal(ctx.stub.calls[0].width, 640);
    assert.equal(ctx.stub.calls[0].height, 384);
    const audit = ctx.db.prepare('SELECT raw_meta FROM shot_image_provider_audit WHERE project_id = ? AND shot_id = ?').get('p1', 's1') as any;
    const rawMeta = JSON.parse(audit.raw_meta);
    assert.equal(rawMeta.styleBundle.width, 640);
    assert.equal(rawMeta.styleBundle.height, 384);
  } finally {
    await ctx.close();
  }
});

test('missing, null, or failed style context preserves legacy Agnes behavior with one structured warning', async () => {
  const cases: Array<{
    name: string;
    resolver?: (projectId: string, shotId: string) => ImageStyleContext | null;
  }> = [
    { name: 'missing' },
    { name: 'null', resolver: () => null },
    { name: 'failed', resolver: () => { throw new Error('style resolver exploded'); } },
  ];

  for (const item of cases) {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    const ctx = await startApp({ autoRoute: false, resolveStyleContext: item.resolver });
    try {
      writeShotStyleVersion(ctx.db, 's1', 99);
      const { status, body } = await ctx.post({ ...normalEmptyShotBody, forceProvider: 'agnes' });
      assert.equal(status, 200, item.name);
      assert.equal(ctx.stub.calls[0].prompt, normalEmptyShotBody.prompt, item.name);
      assert.equal(ctx.stub.calls[0].width, 1024, item.name);
      assert.equal(ctx.stub.calls[0].height, 1024, item.name);
      assert.equal(Object.prototype.hasOwnProperty.call(body, 'styleContractVersion'), false, item.name);
      assert.equal(Object.prototype.hasOwnProperty.call(readShot(ctx.db, 's1'), 'gen_style_contract_version'), false, item.name);
      assert.equal(warnings.filter(warning => warning.includes('style_context_unavailable')).length, 1, item.name);
    } finally {
      console.warn = originalWarn;
      await ctx.close();
    }
  }
});

test('ComfyUI routing never resolves or consumes the Agnes style bundle', async () => {
  let resolverCalls = 0;
  const ctx = await startApp({
    autoRoute: false,
    resolveStyleContext: () => {
      resolverCalls += 1;
      return styleContext;
    },
  });
  try {
    const { status, body } = await ctx.post({
      ...normalEmptyShotBody,
      forceProvider: 'comfyui_local',
    });
    assert.equal(status, 200);
    assert.equal(body.taskId, 'legacy-task-1');
    assert.equal(resolverCalls, 0);
    assert.equal(ctx.stub.calls.length, 0);
  } finally {
    await ctx.close();
  }
});

test('double submission for the same shot returns 409 and calls Agnes only once', async () => {
  const stub = new StubAgnesProvider();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  stub.behavior = async req => {
    await gate;
    return {
      provider: 'agnes',
      requestId: 'stub-slow',
      imagePath: `/uploads/images/agnes/shot-${req.shotId}-slow.png`,
      seedUsed: undefined,
      rawMeta: {},
    };
  };
  const ctx = await startApp({ autoRoute: false, stub });
  try {
    const body = { ...normalEmptyShotBody, forceProvider: 'agnes', width: 1024, height: 1024 };
    const first = ctx.post(body);
    // 等第一个请求确实进入 provider 后再发第二个,模拟连点。
    while (stub.calls.length === 0) await new Promise(resolve => setTimeout(resolve, 5));
    const second = await ctx.post(body);
    assert.equal(second.status, 409);
    release();
    const firstResult = await first;
    assert.equal(firstResult.status, 200);
    assert.equal(stub.calls.length, 1);
  } finally {
    await ctx.close();
  }
});

test('Agnes failure returns 502, records the error, and never falls back to the legacy pipeline', async () => {
  const stub = new StubAgnesProvider();
  stub.behavior = async () => { throw new Error('Agnes exploded'); };
  const ctx = await startApp({ autoRoute: false, stub });
  try {
    const { status, body } = await ctx.post({ ...normalEmptyShotBody, forceProvider: 'agnes', width: 1024, height: 1024 });
    assert.equal(status, 502);
    assert.equal(body.provider, 'agnes');
    assert.equal(ctx.legacyCalls.length, 0);
    const audit = ctx.db.prepare('SELECT * FROM shot_image_provider_audit WHERE project_id = ? AND shot_id = ?').get('p1', 's1') as any;
    assert.match(audit.provider_error, /Agnes exploded/);
  } finally {
    await ctx.close();
  }
});
