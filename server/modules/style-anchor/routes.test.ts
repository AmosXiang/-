import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';
import sharp from 'sharp';
import { buildRecipeFingerprint } from '../../providers/imageGen/recipeFingerprint.ts';
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
  app.use(express.json());
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

function recipe(loraStrength = 0.8) {
  return buildRecipeFingerprint({
    provider: 'agnes',
    model: 'agnes-image-2.1-flash',
    workflowPresetId: null,
    styleContractVersion: 2,
    styleAnchorVersion: 1,
    params: { width: 1280, height: 720, loraStrength },
  });
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

test('approved recipe pins and clears the exact P1-A recipe snapshot', async () => {
  await withServer(async (baseUrl, fx) => {
    const sourceRecipe = recipe();
    await fx.mutateDb(store => {
      store.generated_scripts[0].newShots = [{ id: 'shot-1', gen_recipe: sourceRecipe }];
    });
    const pinned = await fetch(`${baseUrl}/api/projects/project-1/approved-recipe`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shotId: 'shot-1' }),
    });
    assert.equal(pinned.status, 200);
    const approvedRecipe = (await pinned.json() as any).approvedRecipe;
    assert.equal(approvedRecipe.fingerprint, sourceRecipe.fingerprint);
    assert.deepEqual(approvedRecipe.recipe, sourceRecipe);
    assert.equal(approvedRecipe.setFromShotId, 'shot-1');
    assert.deepEqual(fx.project().approvedRecipe, approvedRecipe);

    const cleared = await fetch(`${baseUrl}/api/projects/project-1/approved-recipe`, { method: 'DELETE' });
    assert.equal(cleared.status, 200);
    assert.equal('approvedRecipe' in fx.project(), false);
  });
});

test('style approval snapshots the current fingerprint, can be revoked, and rejects invalid sources', async () => {
  await withServer(async (baseUrl, fx) => {
    const sourceRecipe = recipe();
    await fx.mutateDb(store => {
      store.generated_scripts[0].newShots = [
        { id: 'shot-1', gen_recipe: sourceRecipe },
        { id: 'shot-no-recipe' },
      ];
    });
    const endpoint = `${baseUrl}/api/generated-scripts/project-1/shots/shot-1/style-approved`;
    const approved = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
    assert.equal(approved.status, 200);
    const styleApproved = (await approved.json() as any).styleApproved;
    assert.equal(styleApproved.approvedFingerprint, sourceRecipe.fingerprint);
    assert.deepEqual(fx.project().newShots[0].styleApproved, styleApproved);

    const revoked = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: false }),
    });
    assert.equal(revoked.status, 200);
    assert.equal('styleApproved' in fx.project().newShots[0], false);

    const invalidState = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: 'yes' }),
    });
    assert.equal(invalidState.status, 400);
    assert.equal((await invalidState.json() as any).code, 'APPROVED_STATE_INVALID');

    const noRecipe = await fetch(`${baseUrl}/api/generated-scripts/project-1/shots/shot-no-recipe/style-approved`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
    assert.equal(noRecipe.status, 422);
    assert.equal((await noRecipe.json() as any).code, 'RECIPE_MISSING');

    const missingShot = await fetch(`${baseUrl}/api/projects/project-1/approved-recipe`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shotId: 'missing' }),
    });
    assert.equal(missingShot.status, 404);
    assert.equal((await missingShot.json() as any).code, 'SHOT_NOT_FOUND');

    const missingProject = await fetch(`${baseUrl}/api/projects/missing/approved-recipe`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shotId: 'shot-1' }),
    });
    assert.equal(missingProject.status, 404);
    assert.equal((await missingProject.json() as any).code, 'PROJECT_NOT_FOUND');

    const missingProjectApproval = await fetch(`${baseUrl}/api/generated-scripts/missing/shots/shot-1/style-approved`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
    assert.equal(missingProjectApproval.status, 404);
    assert.equal((await missingProjectApproval.json() as any).code, 'PROJECT_NOT_FOUND');
  });
});
