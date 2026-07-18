import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';
import sharp from 'sharp';
import { registerStyleAnchorModule } from './routes.ts';

function fixture() {
  let store: any = { generated_scripts: [{ id: 'project-1', newShots: [] }] };
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'style-anchor-test-'));
  return {
    uploadsDir,
    readDb: () => JSON.parse(JSON.stringify(store)),
    mutateDb: async (mutator: (db: any) => void | Promise<void>) => {
      const next = JSON.parse(JSON.stringify(store));
      await mutator(next);
      store = next;
    },
    project: () => store.generated_scripts[0],
    close: () => fs.rmSync(uploadsDir, { recursive: true, force: true }),
  };
}

async function withServer(run: (baseUrl: string, fx: ReturnType<typeof fixture>) => Promise<void>) {
  const fx = fixture();
  const app = express();
  registerStyleAnchorModule(app, fx);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, fx);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fx.close();
  }
}

async function png(red: number): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 2, channels: 3, background: { r: red, g: 20, b: 30 } } }).png().toBuffer();
}

async function put(baseUrl: string, bytes?: Buffer, note?: string) {
  const form = new FormData();
  if (bytes) form.append('image', new Blob([bytes], { type: 'image/png' }), 'anchor.png');
  if (note !== undefined) form.append('note', note);
  return fetch(`${baseUrl}/api/projects/project-1/style-anchor`, { method: 'PUT', body: form });
}

test('GET returns null for legacy projects and a machine-readable 404', async () => {
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/api/projects/project-1/style-anchor`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { styleAnchor: null });
    const missing = await fetch(`${baseUrl}/api/projects/missing/style-anchor`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json() as any).code, 'PROJECT_NOT_FOUND');
  });
});

test('set starts at v1, identical bytes are idempotent, and changed bytes increment the version', async () => {
  await withServer(async (baseUrl, fx) => {
    const first = await put(baseUrl, await png(10), 'cold cyan ink');
    assert.equal(first.status, 200);
    const firstAnchor = (await first.json() as any).styleAnchor;
    assert.equal(firstAnchor.version, 1);
    assert.equal(firstAnchor.note, 'cold cyan ink');
    assert.equal(firstAnchor.imageUrl, '/uploads/style-anchors/project-1-1.png');
    assert.equal(fs.existsSync(path.join(fx.uploadsDir, 'style-anchors', 'project-1-1.png')), true);

    const same = await put(baseUrl, await png(10), 'cold cyan ink, soft grain');
    assert.equal(same.status, 200);
    const sameAnchor = (await same.json() as any).styleAnchor;
    assert.equal(sameAnchor.version, 1);
    assert.equal(sameAnchor.imageUrl, firstAnchor.imageUrl);
    assert.equal(sameAnchor.note, 'cold cyan ink, soft grain');

    const changed = await put(baseUrl, await png(200), 'warm red ink');
    assert.equal(changed.status, 200);
    const changedAnchor = (await changed.json() as any).styleAnchor;
    assert.equal(changedAnchor.version, 2);
    assert.equal(changedAnchor.imageUrl, '/uploads/style-anchors/project-1-2.png');
    assert.equal(fs.existsSync(path.join(fx.uploadsDir, 'style-anchors', 'project-1-1.png')), false);
    assert.equal(fs.existsSync(path.join(fx.uploadsDir, 'style-anchors', 'project-1-2.png')), true);
    assert.deepEqual(fx.project().styleAnchor, changedAnchor);
  });
});

test('note-only updates keep the asset version and DELETE removes both JSON field and file', async () => {
  await withServer(async (baseUrl, fx) => {
    await put(baseUrl, await png(50), 'first');
    const noteOnly = await put(baseUrl, undefined, 'second');
    assert.equal(noteOnly.status, 200);
    assert.equal((await noteOnly.json() as any).styleAnchor.version, 1);
    const removed = await fetch(`${baseUrl}/api/projects/project-1/style-anchor`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { success: true, styleAnchor: null });
    assert.equal('styleAnchor' in fx.project(), false);
    assert.equal(fs.existsSync(path.join(fx.uploadsDir, 'style-anchors', 'project-1-1.png')), false);
  });
});

test('upload rejects non-images and stored path traversal is never unlinked', async () => {
  await withServer(async (baseUrl, fx) => {
    const form = new FormData();
    form.append('image', new Blob(['not an image'], { type: 'text/plain' }), 'bad.txt');
    const badType = await fetch(`${baseUrl}/api/projects/project-1/style-anchor`, { method: 'PUT', body: form });
    assert.equal(badType.status, 415);
    assert.equal((await badType.json() as any).code, 'IMAGE_TYPE_INVALID');

    await fx.mutateDb(store => {
      store.generated_scripts[0].styleAnchor = {
        imageUrl: '/uploads/style-anchors/../outside.png', version: 1, updatedAt: new Date().toISOString(),
      };
    });
    const clear = await fetch(`${baseUrl}/api/projects/project-1/style-anchor`, { method: 'DELETE' });
    assert.equal(clear.status, 422);
    assert.equal((await clear.json() as any).code, 'IMAGE_PATH_INVALID');
    assert.equal('styleAnchor' in fx.project(), true);
  });
});
