import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import express from 'express';
import { registerShotReviewModule } from './routes.ts';
import { resolveLocalUploadFile, ShotReviewError } from './workflow.ts';

type Fixture = ReturnType<typeof createFixture>;

function createFixture(shots: any[] = [{ id: 'shot-1', description: 'current prompt', isStale: true }]) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE store (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE comfyui_tasks (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      targetId TEXT NOT NULL,
      targetType TEXT NOT NULL,
      viewType TEXT NOT NULL,
      prompt TEXT NOT NULL,
      negativePrompt TEXT NOT NULL,
      seed TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      imageUrl TEXT,
      workflowPresetId TEXT,
      createdAt TEXT NOT NULL
    );
  `);
  const project = { id: 'project-1', newTitle: 'Test', newShots: shots };
  db.prepare("INSERT INTO store (key, value) VALUES ('generated_scripts', ?)").run(JSON.stringify([project]));
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-review-uploads-'));

  const mutateDb = async (mutator: (store: any) => void | Promise<void>) => {
    const row = db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get() as { value: string };
    const store = { generated_scripts: JSON.parse(row.value) };
    await mutator(store);
    db.prepare("UPDATE store SET value = ? WHERE key = 'generated_scripts'").run(JSON.stringify(store.generated_scripts));
  };

  const insertTask = (overrides: Record<string, unknown> = {}) => {
    const task = {
      id: 'task-1',
      projectId: 'project-1',
      targetId: 'shot-1',
      targetType: 'shot',
      viewType: 'main',
      prompt: 'current prompt',
      negativePrompt: '',
      seed: '123',
      model: 'test-model',
      status: 'succeeded',
      imageUrl: '/uploads/projects/project-1/shot-1.png',
      workflowPresetId: null,
      createdAt: '2026-07-14T10:00:00.000Z',
      ...overrides,
    };
    db.prepare(`
      INSERT INTO comfyui_tasks (
        id, projectId, targetId, targetType, viewType, prompt, negativePrompt,
        seed, model, status, imageUrl, workflowPresetId, createdAt
      ) VALUES (
        @id, @projectId, @targetId, @targetType, @viewType, @prompt, @negativePrompt,
        @seed, @model, @status, @imageUrl, @workflowPresetId, @createdAt
      )
    `).run(task);
    return task;
  };

  const writeImage = (relative = path.join('projects', 'project-1', 'shot-1.png')) => {
    const destination = path.join(uploadsDir, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, 'fake-png');
    return destination;
  };

  const readShot = (shotId = 'shot-1') => {
    const row = db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get() as { value: string };
    return JSON.parse(row.value)[0].newShots.find((shot: any) => shot.id === shotId);
  };

  return { db, uploadsDir, mutateDb, insertTask, writeImage, readShot };
}

async function withServer(fixture: Fixture, run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  registerShotReviewModule(app, fixture.db, {
    mutateDb: fixture.mutateDb,
    uploadsDir: fixture.uploadsDir,
  });
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fixture.db.close();
    fs.rmSync(fixture.uploadsDir, { recursive: true, force: true });
  }
}

test('versions are newest-first and mark the finalized task; old shots remain compatible', async () => {
  const fixture = createFixture([{ id: 'shot-1', description: 'current prompt', finalTaskId: 'new-task' }]);
  fixture.insertTask({ id: 'old-task', createdAt: '2026-07-14T09:00:00.000Z' });
  fixture.insertTask({ id: 'new-task', createdAt: '2026-07-14T11:00:00.000Z' });
  await withServer(fixture, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/generated-scripts/project-1/shots/shot-1/versions`);
    assert.equal(response.status, 200);
    const body: any = await response.json();
    assert.deepEqual(body.versions.map((version: any) => version.taskId), ['new-task', 'old-task']);
    assert.equal(body.versions[0].isFinal, true);
    assert.equal(body.versions[1].isFinal, false);
  });
});

test('finalization rejects invalid tasks and local image failures', async () => {
  const fixture = createFixture();
  fixture.insertTask({ id: 'wrong-shot', targetId: 'shot-other' });
  fixture.insertTask({ id: 'failed-task', status: 'failed' });
  fixture.insertTask({ id: 'remote-task', imageUrl: 'https://example.com/image.png' });
  fixture.insertTask({ id: 'missing-file', imageUrl: '/uploads/projects/project-1/missing.png' });
  await withServer(fixture, async baseUrl => {
    const endpoint = `${baseUrl}/api/generated-scripts/project-1/shots/shot-1/final`;
    for (const [taskId, code] of [
      ['no-such-task', 'TASK_NOT_FOUND'],
      ['wrong-shot', 'TASK_SHOT_MISMATCH'],
      ['failed-task', 'TASK_NOT_SUCCEEDED'],
      ['remote-task', 'IMAGE_NOT_LOCAL'],
      ['missing-file', 'IMAGE_FILE_MISSING'],
    ]) {
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });
      assert.equal(response.status, 400, taskId);
      assert.equal((await response.json() as any).code, code, taskId);
    }
  });
});

test('finalize and cancel preserve the independent isStale flag', async () => {
  const fixture = createFixture();
  fixture.writeImage();
  fixture.insertTask();
  await withServer(fixture, async baseUrl => {
    const endpoint = `${baseUrl}/api/generated-scripts/project-1/shots/shot-1/final`;
    const finalized = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-1' }),
    });
    assert.equal(finalized.status, 200);
    assert.deepEqual(
      { ...fixture.readShot(), description: undefined },
      {
        id: 'shot-1',
        description: undefined,
        isStale: true,
        finalTaskId: 'task-1',
        finalizedImageUrl: '/uploads/projects/project-1/shot-1.png',
      },
    );

    const cancelled = await fetch(endpoint, { method: 'DELETE' });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(fixture.readShot(), { id: 'shot-1', description: 'current prompt', isStale: true });
  });
});

test('mark-stale is atomic and supports legacy shots without review fields', async () => {
  const fixture = createFixture([
    { id: 'shot-1', description: 'one' },
    { id: 'shot-2', description: 'two' },
  ]);
  await withServer(fixture, async baseUrl => {
    const endpoint = `${baseUrl}/api/generated-scripts/project-1/shots/mark-stale`;
    const bad = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shotIds: ['shot-1', 'missing'], isStale: true }),
    });
    assert.equal(bad.status, 400);
    assert.equal(fixture.readShot('shot-1').isStale, undefined);

    const good = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shotIds: ['shot-1', 'shot-2'], isStale: true }),
    });
    assert.equal(good.status, 200);
    assert.equal(fixture.readShot('shot-1').isStale, true);
    assert.equal(fixture.readShot('shot-2').isStale, true);
  });
});

test('stale-check compares the latest successful task prompt with current shot input', async () => {
  const fixture = createFixture([
    { id: 'shot-1', optimizedPrompt: 'new prompt' },
    { id: 'shot-2', optimizedPrompt: 'same prompt' },
    { id: 'shot-3', cameraPromptUsed: 'camera right' },
  ]);
  fixture.insertTask({ id: 'stale', targetId: 'shot-1', prompt: 'old prompt' });
  fixture.insertTask({
    id: 'identity-current',
    targetId: 'shot-2',
    prompt: 'IDENTITY PRIORITY: preserve Ada. SHOT: same prompt',
  });
  fixture.insertTask({
    id: 'camera-current',
    targetId: 'shot-3',
    prompt: 'camera right',
    workflowPresetId: '04_qwen_edit_2512_camera_derive',
  });
  await withServer(fixture, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/generated-scripts/project-1/stale-check`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      staleShots: [{ shotId: 'shot-1', reason: 'prompt_snapshot_differs' }],
    });
  });
});

test('local image resolution blocks traversal and missing files', () => {
  const fixture = createFixture();
  fixture.writeImage();
  assert.ok(resolveLocalUploadFile('/uploads/projects/project-1/shot-1.png', fixture.uploadsDir).endsWith('shot-1.png'));
  for (const value of ['https://example.com/x.png', '/uploads/../outside.png', '/uploads/missing.png']) {
    assert.throws(
      () => resolveLocalUploadFile(value, fixture.uploadsDir),
      (error: any) => error instanceof ShotReviewError && error.status === 400,
      value,
    );
  }
  fixture.db.close();
  fs.rmSync(fixture.uploadsDir, { recursive: true, force: true });
});
