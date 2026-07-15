import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import express from 'express';
import { registerStyleContractModule } from './routes.ts';
import { resolveEffectiveStyleContract, type StyleContractFields } from './workflow.ts';

type Fixture = ReturnType<typeof createFixture>;

const VALID_CONTRACT: StyleContractFields = {
  storyboardPresetId: 'pure_klein',
  styleOverlay: 'cinematic teal-orange lighting',
  width: 1024,
  height: 1024,
  loraStrength: 1,
};

function createFixture() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE store (key TEXT PRIMARY KEY, value TEXT)');
  const projects = [
    {
      id: 'project-1',
      comfyuiPreferences: { shotPresetId: 'sdxl_legacy', characterMasterPresetId: 'pure_klein' },
      artDirection: { overlay: 'legacy film grain', updatedAt: '2026-01-01T00:00:00.000Z', analysis: { source: 'image' } },
      newShots: [],
    },
    { id: 'project-2', newShots: [] },
  ];
  db.prepare("INSERT INTO store (key, value) VALUES ('generated_scripts', ?)").run(JSON.stringify(projects));

  const readDb = () => {
    const row = db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get() as { value: string };
    return { generated_scripts: JSON.parse(row.value) };
  };
  const mutateDb = async (mutator: (store: any) => void | Promise<void>) => {
    const store = readDb();
    await mutator(store);
    db.prepare("UPDATE store SET value = ? WHERE key = 'generated_scripts'").run(JSON.stringify(store.generated_scripts));
  };
  const readProject = (id = 'project-1') => readDb().generated_scripts.find((project: any) => project.id === id);
  return { db, readDb, mutateDb, readProject };
}

async function withServer(fixture: Fixture, run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  registerStyleContractModule(app, { readDb: fixture.readDb, mutateDb: fixture.mutateDb });
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

function putContract(baseUrl: string, contract: unknown = VALID_CONTRACT, lock?: unknown, projectId = 'project-1') {
  return fetch(`${baseUrl}/api/generated-scripts/${projectId}/style-contract`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contract, ...(lock === undefined ? {} : { lock }) }),
  });
}

function setLocked(baseUrl: string, locked: unknown, projectId = 'project-1') {
  return fetch(`${baseUrl}/api/generated-scripts/${projectId}/style-contract/lock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ locked }),
  });
}

test('GET derives an unpersisted draft from legacy fields and returns a machine-readable 404', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/generated-scripts/project-1/style-contract`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      initialized: false,
      version: 0,
      locked: false,
      contract: {
        storyboardPresetId: 'sdxl_legacy',
        styleOverlay: 'legacy film grain',
        width: 1024,
        height: 1024,
        loraStrength: 1,
      },
    });
    assert.equal(fixture.readProject().styleContract, undefined);

    const missing = await fetch(`${baseUrl}/api/generated-scripts/missing/style-contract`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json() as any).code, 'PROJECT_NOT_FOUND');
  });
});

test('PUT creates v1, writes through legacy fields, increments changed content, and keeps no-op PUT idempotent', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    const first = await putContract(baseUrl);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { success: true, version: 1, locked: false, contract: VALID_CONTRACT });
    const afterFirst = fixture.readProject();
    assert.equal(afterFirst.comfyuiPreferences.shotPresetId, 'pure_klein');
    assert.equal(afterFirst.comfyuiPreferences.characterMasterPresetId, 'pure_klein');
    assert.equal(afterFirst.artDirection.overlay, VALID_CONTRACT.styleOverlay);
    assert.deepEqual(afterFirst.artDirection.analysis, { source: 'image' });
    const firstUpdatedAt = afterFirst.styleContract.updatedAt;

    const noOp = await putContract(baseUrl);
    assert.equal(noOp.status, 200);
    assert.equal((await noOp.json() as any).version, 1);
    assert.equal(fixture.readProject().styleContract.updatedAt, firstUpdatedAt);

    const changedContract = { ...VALID_CONTRACT, width: 1280 };
    const changed = await putContract(baseUrl, changedContract);
    assert.equal(changed.status, 200);
    assert.deepEqual(await changed.json(), { success: true, version: 2, locked: false, contract: changedContract });
    assert.equal(fixture.readProject().styleContract.version, 2);

    assert.deepEqual(resolveEffectiveStyleContract(fixture.readDb, 'project-1'), {
      version: 2,
      locked: false,
      ...changedContract,
    });
  });
});

test('lock and unlock do not bump version, locked PUT is rejected, and save-and-lock is atomic', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    assert.equal((await putContract(baseUrl)).status, 200);

    const lock = await setLocked(baseUrl, true);
    assert.equal(lock.status, 200);
    assert.deepEqual(await lock.json(), { success: true, version: 1, locked: true });

    const blocked = await putContract(baseUrl, { ...VALID_CONTRACT, height: 1280 });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json() as any).code, 'CONTRACT_LOCKED');
    assert.equal(fixture.readProject().styleContract.version, 1);

    const unlock = await setLocked(baseUrl, false);
    assert.equal(unlock.status, 200);
    assert.deepEqual(await unlock.json(), { success: true, version: 1, locked: false });

    const changedContract = { ...VALID_CONTRACT, height: 1280 };
    const saveAndLock = await putContract(baseUrl, changedContract, true);
    assert.equal(saveAndLock.status, 200);
    assert.deepEqual(await saveAndLock.json(), { success: true, version: 2, locked: true, contract: changedContract });
  });
});

test('preflight and lock report deterministic missing fields and become ready only after a locked save', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    const before = await fetch(`${baseUrl}/api/generated-scripts/project-2/style-contract/preflight`);
    assert.deepEqual(await before.json(), {
      ready: false,
      locked: false,
      missing: ['storyboardPresetId', 'styleOverlay', 'width', 'height', 'loraStrength'],
    });

    const incomplete = await setLocked(baseUrl, true, 'project-2');
    assert.equal(incomplete.status, 422);
    assert.deepEqual(await incomplete.json(), {
      error: 'The style contract is incomplete.',
      code: 'CONTRACT_INCOMPLETE',
      missing: ['storyboardPresetId', 'styleOverlay', 'width', 'height', 'loraStrength'],
    });

    assert.equal((await putContract(baseUrl, VALID_CONTRACT, true, 'project-2')).status, 200);
    const ready = await fetch(`${baseUrl}/api/generated-scripts/project-2/style-contract/preflight`);
    assert.deepEqual(await ready.json(), { ready: true, locked: true, missing: [] });
  });
});

test('invalid contract and lock inputs return stable 400/422 codes without persisting', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    const cases: Array<[unknown, unknown, number, string, string | undefined]> = [
      [null, undefined, 400, 'STYLE_CONTRACT_REQUIRED', undefined],
      [{ ...VALID_CONTRACT, storyboardPresetId: '   ' }, undefined, 422, 'STYLE_CONTRACT_INVALID', 'storyboardPresetId'],
      [{ ...VALID_CONTRACT, width: 1001 }, undefined, 422, 'STYLE_CONTRACT_INVALID', 'width'],
      [{ ...VALID_CONTRACT, loraStrength: 3 }, undefined, 422, 'STYLE_CONTRACT_INVALID', 'loraStrength'],
      [VALID_CONTRACT, 'yes', 400, 'LOCK_STATE_INVALID', undefined],
    ];
    for (const [contract, lock, status, code, field] of cases) {
      const response = await putContract(baseUrl, contract, lock);
      assert.equal(response.status, status, code);
      const body: any = await response.json();
      assert.equal(body.code, code);
      if (field) assert.equal(body.field, field);
    }
    const badLock = await setLocked(baseUrl, 'yes');
    assert.equal(badLock.status, 400);
    assert.equal((await badLock.json() as any).code, 'LOCK_STATE_INVALID');
    assert.equal(fixture.readProject().styleContract, undefined);
  });
});

test('resolveEffectiveStyleContract falls back to legacy fields without mutating old projects', () => {
  const fixture = createFixture();
  assert.deepEqual(resolveEffectiveStyleContract(fixture.readDb, 'project-1'), {
    version: 0,
    locked: false,
    storyboardPresetId: 'sdxl_legacy',
    styleOverlay: 'legacy film grain',
    width: 1024,
    height: 1024,
    loraStrength: 1,
  });
  assert.equal(fixture.readProject().styleContract, undefined);
  assert.throws(
    () => resolveEffectiveStyleContract(fixture.readDb, 'missing'),
    (error: any) => error.code === 'PROJECT_NOT_FOUND' && error.status === 404,
  );
  fixture.db.close();
});
