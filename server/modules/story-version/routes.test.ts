import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import express from 'express';
import { registerStoryVersionModule } from './routes.ts';

type Fixture = ReturnType<typeof createFixture>;

function createFixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE store (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE comfyui_tasks (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      targetId TEXT NOT NULL,
      targetType TEXT NOT NULL,
      viewType TEXT NOT NULL,
      status TEXT NOT NULL,
      imageUrl TEXT,
      createdAt TEXT NOT NULL
    );
  `);
  const project = {
    id: 'project-1',
    newTitle: '孤岛谜案',
    newNarrative: {
      structure: '第一幕登岛，第二幕调查，第三幕揭晓。',
      rhythm: '00:00 慢，随后逐步加速。',
      climaxDesign: '00:20 发现密室，01:05 揭露真凶，01:05 再次反转。',
    },
    newShots: [
      { id: 'shot-1', description: 'one' },
      { id: 'shot-2', description: 'two' },
      { id: 'shot-3', description: 'three' },
      { id: 'shot-4', description: 'four' },
      { id: 'shot-5', description: 'five' },
    ],
  };
  db.prepare("INSERT INTO store (key, value) VALUES ('generated_scripts', ?)").run(JSON.stringify([project]));

  const mutateDb = async (mutator: (store: any) => void | Promise<void>) => {
    const row = db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get() as { value: string };
    const store = { generated_scripts: JSON.parse(row.value) };
    await mutator(store);
    db.prepare("UPDATE store SET value = ? WHERE key = 'generated_scripts'").run(JSON.stringify(store.generated_scripts));
  };

  const readProject = () => {
    const row = db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get() as { value: string };
    return JSON.parse(row.value)[0];
  };

  const insertTask = (overrides: Record<string, unknown>) => db.prepare(`
    INSERT INTO comfyui_tasks (id, projectId, targetId, targetType, viewType, status, imageUrl, createdAt)
    VALUES (@id, @projectId, @targetId, @targetType, @viewType, @status, @imageUrl, @createdAt)
  `).run({
    id: `task-${Math.random()}`,
    projectId: 'project-1',
    targetId: 'shot-1',
    targetType: 'shot',
    viewType: 'main',
    status: 'succeeded',
    imageUrl: '/uploads/result.png',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

  return { db, mutateDb, readProject, insertTask };
}

async function withServer(fixture: Fixture, run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  registerStoryVersionModule(app, fixture.db, { mutateDb: fixture.mutateDb });
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fixture.db.close();
  }
}

function draft(logline: string) {
  return {
    logline,
    beats: [{ id: '', title: '开端', summary: `${logline} 开始` }],
    hooks: [{ id: '', time: '00:20', label: '反转' }],
  };
}

async function save(baseUrl: string, logline: string, extra: Record<string, unknown> = {}) {
  return fetch(`${baseUrl}/api/generated-scripts/project-1/story`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ storyDraft: draft(logline), ...extra }),
  });
}

test('GET derives an unsaved draft and extracts unique hook timestamps without persisting', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/generated-scripts/project-1/story`);
    assert.equal(response.status, 200);
    const body: any = await response.json();
    assert.equal(body.initialized, false);
    assert.equal(body.storyVersion, 0);
    assert.equal(body.storyDraft.logline, '孤岛谜案');
    assert.deepEqual(body.storyDraft.beats.map((beat: any) => beat.title), ['三幕结构', '节奏', '高潮设计']);
    assert.deepEqual(body.storyDraft.hooks.map((hook: any) => hook.time), ['00:20', '01:05']);
    assert.equal(fixture.readProject().storyDraft, undefined);
  });
});

test('first save creates v1 snapshot immediately and fills missing item ids', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    const response = await save(baseUrl, '版本一', { note: '初稿' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, storyVersion: 1, staleMarked: 0 });

    const current: any = await (await fetch(`${baseUrl}/api/generated-scripts/project-1/story`)).json();
    assert.equal(current.initialized, true);
    assert.deepEqual(current.versions.map((item: any) => item.version), [1]);
    assert.equal(current.versions[0].note, '初稿');
    assert.ok(current.storyDraft.beats[0].id);
    assert.ok(current.storyDraft.hooks[0].id);

    const snapshot = await fetch(`${baseUrl}/api/generated-scripts/project-1/story/versions/1`);
    assert.equal(snapshot.status, 200);
    assert.equal((await snapshot.json() as any).storyDraft.logline, '版本一');
  });
});

test('versions increment, remain newest-first, and retain only the latest ten snapshots', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    for (let version = 1; version <= 12; version += 1) {
      assert.equal((await save(baseUrl, `版本${version}`)).status, 200);
    }
    const body: any = await (await fetch(`${baseUrl}/api/generated-scripts/project-1/story`)).json();
    assert.equal(body.storyVersion, 12);
    assert.deepEqual(body.versions.map((item: any) => item.version), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    assert.equal(fixture.readProject().storyVersions.length, 10);
    const removed = await fetch(`${baseUrl}/api/generated-scripts/project-1/story/versions/2`);
    assert.equal(removed.status, 404);
    assert.equal((await removed.json() as any).code, 'STORY_VERSION_NOT_FOUND');
  });
});

test('markShotsStale follows the exact successful-main-shot-with-image SQL contract', async () => {
  const fixture = createFixture();
  fixture.insertTask({ id: 'valid-1', targetId: 'shot-1' });
  fixture.insertTask({ id: 'valid-1-duplicate', targetId: 'shot-1' });
  fixture.insertTask({ id: 'null-image', targetId: 'shot-2', imageUrl: null });
  fixture.insertTask({ id: 'failed', targetId: 'shot-3', status: 'failed' });
  fixture.insertTask({ id: 'wrong-view', targetId: 'shot-4', viewType: 'front' });
  fixture.insertTask({ id: 'valid-5', targetId: 'shot-5' });
  await withServer(fixture, async baseUrl => {
    const response = await save(baseUrl, '标旧测试', { markShotsStale: true });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as any).staleMarked, 2);
    const shots = fixture.readProject().newShots;
    assert.deepEqual(shots.map((shot: any) => Boolean(shot.isStale)), [true, false, false, false, true]);
  });
});

test('rollback appends an immutable new snapshot and rejects rolling back the current version', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    await save(baseUrl, '版本一');
    await save(baseUrl, '版本二');
    const rollback = await fetch(`${baseUrl}/api/generated-scripts/project-1/story/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(rollback.status, 200);
    assert.equal((await rollback.json() as any).storyVersion, 3);
    const project = fixture.readProject();
    assert.equal(project.storyDraft.logline, '版本一');
    assert.deepEqual(project.storyVersions.map((item: any) => [item.version, item.storyDraft.logline]), [
      [1, '版本一'], [2, '版本二'], [3, '版本一'],
    ]);

    const noOp = await fetch(`${baseUrl}/api/generated-scripts/project-1/story/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 3 }),
    });
    assert.equal(noOp.status, 400);
    assert.equal((await noOp.json() as any).code, 'STORY_VERSION_ALREADY_CURRENT');
  });
});

test('missing versions and invalid inputs return machine-readable 4xx errors', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    const missing = await fetch(`${baseUrl}/api/generated-scripts/project-1/story/versions/99`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json() as any).code, 'STORY_VERSION_NOT_FOUND');

    const cases: Array<[unknown, string]> = [
      [{ storyDraft: null }, 'STORY_DRAFT_INVALID'],
      [{ storyDraft: { logline: 1, beats: [], hooks: [] } }, 'STORY_DRAFT_INVALID'],
      [{ storyDraft: draft('bad'), note: 'x'.repeat(501) }, 'STORY_NOTE_TOO_LONG'],
      [{ storyDraft: draft('bad'), markShotsStale: 'yes' }, 'MARK_SHOTS_STALE_INVALID'],
    ];
    for (const [body, code] of cases) {
      const response = await fetch(`${baseUrl}/api/generated-scripts/project-1/story`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, code);
      assert.equal((await response.json() as any).code, code);
    }
    assert.equal(fixture.readProject().storyVersion, undefined);
  });
});
