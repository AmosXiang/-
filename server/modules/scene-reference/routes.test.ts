import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import express from 'express';
import { registerSceneReferenceModule } from './routes.ts';

type Fixture = ReturnType<typeof createFixture>;

function createFixture() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE store (key TEXT PRIMARY KEY, value TEXT)');
  const projects = [
    {
      id: 'project-1',
      newShots: [
        { id: 'shot-1', description: 'Hallway' },
        { id: 'shot-2', description: 'Garden' },
      ],
    },
  ];
  db.prepare("INSERT INTO store (key, value) VALUES ('generated_scripts', ?)").run(JSON.stringify(projects));
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-reference-test-'));

  const readDb = () => {
    const row = db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get() as { value: string };
    return { generated_scripts: JSON.parse(row.value) };
  };
  const mutateDb = async (mutator: (store: any) => void | Promise<void>) => {
    const store = readDb();
    await mutator(store);
    db.prepare("UPDATE store SET value = ? WHERE key = 'generated_scripts'").run(JSON.stringify(store.generated_scripts));
  };
  const readProject = () => readDb().generated_scripts[0];
  const close = () => {
    db.close();
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  };
  return { db, uploadsDir, readDb, mutateDb, readProject, close };
}

async function withServer(fixture: Fixture, run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  registerSceneReferenceModule(app, fixture);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fixture.close();
  }
}

function putScenes(baseUrl: string, scenes: unknown, projectId = 'project-1') {
  return fetch(`${baseUrl}/api/generated-scripts/${projectId}/scene-references`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenes }),
  });
}

test('GET returns an empty list for legacy projects and a machine-readable 404', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/generated-scripts/project-1/scene-references`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { scenes: [] });

    const missing = await fetch(`${baseUrl}/api/generated-scripts/missing/scene-references`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json() as any).code, 'PROJECT_NOT_FOUND');
  });
});

test('PUT fills UUIDs, validates names and limits, and rejects forged imageUrl values', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    const created = await putScenes(baseUrl, [{ name: '  Mansion Hall  ', overlay: 'dark oak, cold moonlight' }]);
    assert.equal(created.status, 200);
    const body: any = await created.json();
    assert.equal(body.scenes.length, 1);
    assert.match(body.scenes[0].id, /^[0-9a-f-]{36}$/);
    assert.equal(body.scenes[0].name, 'Mansion Hall');
    assert.equal(body.scenes[0].overlay, 'dark oak, cold moonlight');
    assert.match(body.scenes[0].updatedAt, /^\d{4}-\d{2}-\d{2}T/);

    const blankName = await putScenes(baseUrl, [{ name: '   ' }]);
    assert.equal(blankName.status, 422);
    assert.equal((await blankName.json() as any).code, 'SCENE_REFERENCE_INVALID');

    const tooMany = await putScenes(baseUrl, Array.from({ length: 21 }, (_, index) => ({ name: `Scene ${index}` })));
    assert.equal(tooMany.status, 422);
    assert.equal((await tooMany.json() as any).code, 'SCENE_LIMIT_EXCEEDED');

    const longOverlay = await putScenes(baseUrl, [{ name: 'Too verbose', overlay: 'x'.repeat(2001) }]);
    assert.equal(longOverlay.status, 422);
    assert.equal((await longOverlay.json() as any).code, 'SCENE_OVERLAY_TOO_LONG');

    const duplicateId = await putScenes(baseUrl, [{ id: 'same', name: 'One' }, { id: 'same', name: 'Two' }]);
    assert.equal(duplicateId.status, 422);
    assert.equal((await duplicateId.json() as any).code, 'SCENE_ID_DUPLICATE');

    const forgedNew = await putScenes(baseUrl, [{ name: 'Fake', imageUrl: '/uploads/forged.png' }]);
    assert.equal(forgedNew.status, 422);
    assert.equal((await forgedNew.json() as any).code, 'IMAGE_URL_READ_ONLY');

    const forgedExisting = await putScenes(baseUrl, [{ ...body.scenes[0], imageUrl: '/uploads/forged.png' }]);
    assert.equal(forgedExisting.status, 422);
    assert.equal((await forgedExisting.json() as any).code, 'IMAGE_URL_READ_ONLY');
    assert.equal(fixture.readProject().sceneReferences[0].imageUrl, undefined);
  });
});

test('image upload writes under scene-refs and updates only the matching scene imageUrl', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    const created: any = await (await putScenes(baseUrl, [{ id: 'scene-1', name: 'Garden' }])).json();
    const previousUpdatedAt = created.scenes[0].updatedAt;
    const form = new FormData();
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    form.append('image', new Blob([bytes], { type: 'image/png' }), 'garden.png');
    const response = await fetch(`${baseUrl}/api/generated-scripts/project-1/scene-references/scene-1/image`, {
      method: 'POST',
      body: form,
    });
    assert.equal(response.status, 200);
    const body: any = await response.json();
    assert.match(body.scene.imageUrl, /^\/uploads\/scene-refs\/[0-9a-f-]+\.png$/);
    assert.ok(body.scene.updatedAt >= previousUpdatedAt);
    const relative = body.scene.imageUrl.replace('/uploads/', '').split('/');
    const written = path.join(fixture.uploadsDir, ...relative);
    assert.equal(fs.existsSync(written), true);
    assert.deepEqual(fs.readFileSync(written), Buffer.from(bytes));
    assert.equal(fixture.readProject().sceneReferences[0].imageUrl, body.scene.imageUrl);
  });
});

test('shot tagging accepts a known scene, rejects unknown scenes, and removes the tag with null', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    assert.equal((await putScenes(baseUrl, [{ id: 'scene-1', name: 'Hall' }])).status, 200);
    const endpoint = `${baseUrl}/api/generated-scripts/project-1/shots/shot-1/scene`;
    const tag = await fetch(endpoint, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sceneId: 'scene-1' }),
    });
    assert.equal(tag.status, 200);
    assert.equal((await tag.json() as any).shot.sceneId, 'scene-1');

    const unknown = await fetch(endpoint, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sceneId: 'missing' }),
    });
    assert.equal(unknown.status, 422);
    assert.equal((await unknown.json() as any).code, 'SCENE_NOT_FOUND');
    assert.equal(fixture.readProject().newShots[0].sceneId, 'scene-1');

    const remove = await fetch(endpoint, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sceneId: null }),
    });
    assert.equal(remove.status, 200);
    assert.equal('sceneId' in (await remove.json() as any).shot, false);
  });
});

test('deleting a scene reports orphaned shots without clearing their sceneId', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    assert.equal((await putScenes(baseUrl, [
      { id: 'scene-1', name: 'Hall' },
      { id: 'scene-2', name: 'Garden' },
    ])).status, 200);
    await fixture.mutateDb(store => {
      const project = store.generated_scripts[0];
      project.newShots[0].sceneId = 'scene-1';
      project.newShots[1].sceneId = 'scene-2';
    });

    const response = await putScenes(baseUrl, [{ id: 'scene-2', name: 'Garden' }]);
    assert.equal(response.status, 200);
    const body: any = await response.json();
    assert.equal(body.orphanedShotCount, 1);
    assert.equal(fixture.readProject().newShots[0].sceneId, 'scene-1');
    assert.equal(fixture.readProject().newShots[1].sceneId, 'scene-2');
  });
});
