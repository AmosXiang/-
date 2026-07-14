import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore
import Database from 'better-sqlite3';
// @ts-ignore
import JSZip from 'jszip';
import { registerExportDeckModule } from './routes.ts';

const JSZipConstructor = typeof JSZip === 'function' ? JSZip : (JSZip as any).default;

function makeMockRes() {
  const res: any = {};
  res.statusCode = 200;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data: any) => {
    res.body = data;
    return res;
  };
  return res;
}

test('Export Deck Module API and Generator Tests', async (t) => {
  // 1. Setup isolated resources
  const tempUploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-deck-test-uploads-'));
  const db = new Database(':memory:');

  // Create schema with imageUrl column
  db.exec(`
    CREATE TABLE IF NOT EXISTS store (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS comfyui_tasks (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      targetId TEXT NOT NULL,
      targetType TEXT NOT NULL,
      viewType TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      imageUrl TEXT
    );
  `);

  // Prepare mock data
  const mockScript = {
    id: 'proj-1',
    newTitle: 'Test Project Title',
    topic: 'Sci-Fi Theme',
    templateTitle: 'Classic Sci-Fi template',
    newNarrative: {
      structure: 'Three-act structure detailing space exploration.',
      rhythm: 'Slow build-up with intense action sequences.',
      climaxDesign: 'Starship jumps through a black hole.',
    },
    newCharacters: [
      {
        id: 'char-1',
        name: 'Captain Jack',
        role: 'The brave commander.',
        avatarUrl: '/uploads/avatars/jack.png',
      },
      {
        id: 'char-2',
        name: 'Scientist Sue',
        role: 'Chief research officer.',
        avatarUrl: 'https://remote.com/sue.png', // non-local avatar url
      },
    ],
    newShots: [
      // Shot 1: Finalized, valid local image
      {
        id: 'shot-1',
        timestamp: '00:00 - 00:05',
        durationSec: 5,
        description: 'Establishing shot of the starship in deep space.',
        optimizedPrompt: 'cinematic shot of starship, stars, nebula',
        camera: { move: 'pan', speed: 'medium', note: 'smooth pan' },
        framing: { shotSize: 'wide', angle: 'front' },
        cameraH: 'level',
        cameraV: 'front',
        cameraZoom: 'normal',
        derivedFromShotId: null,
        isMaster: true,
        finalTaskId: 'task-1',
        finalizedImageUrl: '/uploads/shot-1-final.png',
        isStale: false,
      },
      // Shot 2: Not finalized, but has local fallback image, stale input
      {
        id: 'shot-2',
        timestamp: '00:05 - 00:10',
        durationSec: 5,
        description: 'Captain Jack looks out of the viewport.',
        optimizedPrompt: 'captain jack portrait, looking worried',
        camera: { move: 'static', speed: 'medium', note: '' },
        framing: { shotSize: 'medium', angle: 'eye-level' },
        cameraH: null,
        cameraV: null,
        cameraZoom: null,
        derivedFromShotId: 'shot-1',
        isMaster: false,
        finalTaskId: null,
        finalizedImageUrl: null,
        isStale: true, // stale warning
        generatedImageUrl: '/uploads/shot-2-fallback.png',
      },
      // Shot 3: Not finalized, no image at all, missing params, latest task failed
      {
        id: 'shot-3',
        timestamp: '00:10 - 00:12',
        durationSec: 0, // missing duration (must be > 0)
        description: 'Alien ship appears out of nowhere.',
        optimizedPrompt: 'alien ship warping in, sci-fi action',
        camera: null, // missing camera
        framing: { shotSize: 'closeup', angle: 'high' }, // missing framing angle / size checked below
        cameraH: null,
        cameraV: null,
        cameraZoom: null,
        derivedFromShotId: null,
        isMaster: false,
        finalTaskId: null,
        finalizedImageUrl: null,
        isStale: false,
      },
    ],
  };

  // Write mock database entries
  db.prepare("INSERT INTO store (key, value) VALUES ('generated_scripts', ?)").run(
    JSON.stringify([mockScript])
  );

  // Write comfyui tasks to test failures and fallback image selection
  // Shot 1 has succeeded task
  db.prepare(`
    INSERT INTO comfyui_tasks (id, projectId, targetId, targetType, viewType, status, createdAt, imageUrl)
    VALUES ('task-1', 'proj-1', 'shot-1', 'shot', 'main', 'succeeded', '2026-07-14T20:00:00Z', '/uploads/shot-1-final.png')
  `).run();

  // Shot 2 has a succeeded task from comfyui (prioritized over shot.generatedImageUrl)
  db.prepare(`
    INSERT INTO comfyui_tasks (id, projectId, targetId, targetType, viewType, status, createdAt, imageUrl)
    VALUES ('task-2', 'proj-1', 'shot-2', 'shot', 'main', 'succeeded', '2026-07-14T20:00:30Z', '/uploads/shot-2-task-success.png')
  `).run();

  // Shot 3 has failed task
  db.prepare(`
    INSERT INTO comfyui_tasks (id, projectId, targetId, targetType, viewType, status, createdAt, imageUrl)
    VALUES ('task-3-failed', 'proj-1', 'shot-3', 'shot', 'main', 'failed', '2026-07-14T20:01:00Z', NULL)
  `).run();

  // Create directory structures inside tempUploadsDir
  fs.mkdirSync(path.join(tempUploadsDir, 'avatars'), { recursive: true });

  // Write dummy images to tempUploadsDir to simulate local resources
  fs.writeFileSync(path.join(tempUploadsDir, 'shot-1-final.png'), 'shot-1-png-content');
  fs.writeFileSync(path.join(tempUploadsDir, 'shot-2-fallback.png'), 'shot-2-fallback-png-content');
  fs.writeFileSync(path.join(tempUploadsDir, 'shot-2-task-success.png'), 'shot-2-task-success-content');
  fs.writeFileSync(path.join(tempUploadsDir, 'avatars', 'jack.png'), 'avatar-jack-content');

  // 2. Register mock express app routes
  const routes: Record<string, Function> = {};
  const mockApp: any = {
    get: (url: string, handler: Function) => {
      routes[`GET:${url}`] = handler;
    },
    post: (url: string, handler: Function) => {
      routes[`POST:${url}`] = handler;
    },
  };

  registerExportDeckModule(mockApp, db, { uploadsDir: tempUploadsDir });

  await t.test('1. GET delivery-check returns correct statistics and details', async () => {
    const req: any = { params: { id: 'proj-1' } };
    const res = makeMockRes();

    const getHandler = routes['GET:/api/generated-scripts/:id/delivery-check'];
    assert.ok(getHandler, 'GET delivery-check handler registered');

    getHandler(req, res);

    assert.equal(res.statusCode, 200);
    const summary = res.body;

    assert.equal(summary.total, 3);
    assert.equal(summary.finalized, 1, 'Only Shot 1 should be finalized');
    assert.equal(summary.notFinalized, 2);
    assert.equal(summary.missingImage, 1, 'Shot 3 has no image at all');
    assert.equal(summary.failed, 1, 'Shot 3 task status is failed');
    assert.equal(summary.missingParams, 1, 'Only Shot 3 has missing parameters');
    assert.equal(summary.stale, 1, 'Shot 2 is stale');

    // Details check
    const details = summary.details;
    assert.equal(details.length, 2, 'Details should contain issues for Shot 2 and Shot 3');

    const shot2Issues = details.find((d: any) => d.shotId === 'shot-2');
    assert.ok(shot2Issues);
    assert.deepEqual(shot2Issues.issues, ['not_finalized', 'stale_input']);

    const shot3Issues = details.find((d: any) => d.shotId === 'shot-3');
    assert.ok(shot3Issues);
    assert.ok(shot3Issues.issues.includes('not_finalized'));
    assert.ok(shot3Issues.issues.includes('missing_image'));
    assert.ok(shot3Issues.issues.includes('missing_camera'));
    assert.ok(shot3Issues.issues.includes('missing_duration'));
    assert.ok(shot3Issues.issues.includes('latest_task_failed'));
  });

  await t.test('2. POST export-deck in final mode is blocked with 409 when unfinalized shots exist', async () => {
    const req: any = {
      params: { id: 'proj-1' },
      body: { mode: 'final' },
    };
    const res = makeMockRes();

    const postHandler = routes['POST:/api/generated-scripts/:id/export-deck'];
    assert.ok(postHandler, 'POST export-deck handler registered');

    await postHandler(req, res);

    assert.equal(res.statusCode, 409);
    assert.ok(res.body.error);
    assert.ok(res.body.missing);
    assert.equal(res.body.missing.length, 2); // Shot 2 and Shot 3 issues returned
  });

  await t.test('3. POST export-deck in review mode successfully generates files with fallback and draft labels', async () => {
    const req: any = {
      params: { id: 'proj-1' },
      body: { mode: 'review' },
    };
    const res = makeMockRes();

    const postHandler = routes['POST:/api/generated-scripts/:id/export-deck'];
    await postHandler(req, res);

    assert.equal(res.statusCode, 200);
    const data = res.body;
    assert.ok(data.success);
    assert.equal(data.mode, 'review');
    assert.ok(data.exportDir);

    // Verify directory safety: No colon (:) in timestamp exportDir folder name
    const folderName = path.basename(data.exportDir);
    assert.ok(!folderName.includes(':'), 'Export directory name must not contain any colons');
    assert.ok(fs.existsSync(data.exportDir), 'Export directory exists');

    // Verify browser URL format in files object
    const files = data.files;
    assert.ok(files.pptxUrl.startsWith('/uploads/exports/proj-1/'));
    assert.ok(files.manifestUrl.startsWith('/uploads/exports/proj-1/'));
    assert.ok(files.zipUrl.startsWith('/uploads/exports/proj-1/'));

    // Check generated files existence
    const pptxPath = path.join(data.exportDir, 'storyboard-deck.pptx');
    const manifestPath = path.join(data.exportDir, 'storyboard-manifest.json');
    const zipPath = path.join(data.exportDir, 'storyboard-delivery.zip');

    assert.ok(fs.existsSync(pptxPath), 'storyboard-deck.pptx exists');
    assert.ok(fs.existsSync(manifestPath), 'storyboard-manifest.json exists');
    assert.ok(fs.existsSync(zipPath), 'storyboard-delivery.zip exists');

    // Check copied finals images
    const finalsDir = path.join(data.exportDir, 'finals');
    assert.ok(fs.existsSync(finalsDir), 'finals directory exists');

    // Shot 1 and Shot 2 should have images copied to finals/
    const copiedShot1 = path.join(finalsDir, 'shot-01.png');
    const copiedShot2 = path.join(finalsDir, 'shot-02.png');
    assert.ok(fs.existsSync(copiedShot1), 'shot-01.png was copied');
    assert.ok(fs.existsSync(copiedShot2), 'shot-02.png was copied');
    assert.equal(fs.readFileSync(copiedShot1, 'utf8'), 'shot-1-png-content');
    
    // VERIFY PRIORITIZATION: Shot 2 should contain task success content rather than fallback content
    assert.equal(fs.readFileSync(copiedShot2, 'utf8'), 'shot-2-task-success-content');

    // Manifest Verification
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.manifestVersion, 1);
    assert.equal(manifest.projectId, 'proj-1');
    assert.equal(manifest.title, 'Test Project Title');
    assert.equal(manifest.mode, 'review');
    assert.equal(manifest.narrative.structure, 'Three-act structure detailing space exploration.');

    // Character table verification in manifest (Jack is valid, Sue is remote and should be null)
    assert.equal(manifest.characters.length, 2);
    assert.equal(manifest.characters[0].name, 'Captain Jack');
    assert.equal(manifest.characters[0].avatarUrl, '/uploads/avatars/jack.png');
    assert.equal(manifest.characters[1].name, 'Scientist Sue');
    assert.equal(manifest.characters[1].avatarUrl, null);

    // Shots verification in manifest
    assert.equal(manifest.shots.length, 3);
    assert.equal(manifest.shots[0].imageFile, 'finals/shot-01.png');
    assert.equal(manifest.shots[0].finalized, true);
    assert.equal(manifest.shots[1].imageFile, 'finals/shot-02.png');
    assert.equal(manifest.shots[1].finalized, false);
    assert.equal(manifest.shots[2].imageFile, null, 'Shot 3 has no image');

    // Zip Package Verification using jszip
    const zipData = fs.readFileSync(zipPath);
    const zip = await JSZipConstructor.loadAsync(zipData);

    assert.ok(zip.file('storyboard-deck.pptx'), 'pptx inside zip');
    assert.ok(zip.file('storyboard-manifest.json'), 'manifest inside zip');
    assert.ok(zip.file('finals/shot-01.png'), 'shot-01 inside zip');
    assert.ok(zip.file('finals/shot-02.png'), 'shot-02 inside zip');
    assert.ok(!zip.file('finals/shot-03.png'), 'shot-03 does not exist inside zip');
  });

  // 3. Clean up temp files
  fs.rmSync(tempUploadsDir, { recursive: true, force: true });
});
