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

    // Slide Count verification (1 cover + 3 shots + 1 contact sheet slide = 5 slides)
    const pptxData = fs.readFileSync(pptxPath);
    const pptxZip = await JSZipConstructor.loadAsync(pptxData);
    const slideXmlFiles = Object.keys(pptxZip.files).filter(filename =>
      filename.startsWith('ppt/slides/slide') && filename.endsWith('.xml')
    );
    assert.equal(slideXmlFiles.length, 5, 'PPTX should have exactly 5 slides (1 cover + 3 shots + 1 contact sheet)');

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

    // Verify README.txt existence and content on disk
    const readmePath = path.join(data.exportDir, 'README.txt');
    assert.ok(fs.existsSync(readmePath), 'README.txt exists on disk');
    const readmeContent = fs.readFileSync(readmePath, 'utf8');
    assert.ok(readmeContent.includes('项目交付包说明文档'), 'README.txt has title');
    assert.ok(readmeContent.includes('Test Project Title'), 'README.txt has project title');
    assert.ok(readmeContent.includes('Captain Jack'), 'README.txt has character name');

    // Verify characters directory existence and content on disk
    const charactersDir = path.join(data.exportDir, 'characters');
    assert.ok(fs.existsSync(charactersDir), 'characters directory exists on disk');
    const jackFolder = path.join(charactersDir, '01_Captain_Jack');
    assert.ok(fs.existsSync(jackFolder), 'Jack folder exists on disk');
    const jackAvatar = path.join(jackFolder, 'avatar.png');
    assert.ok(fs.existsSync(jackAvatar), 'Jack avatar file exists on disk');
    assert.equal(fs.readFileSync(jackAvatar, 'utf8'), 'avatar-jack-content');

    // Verify README.txt and characters folder inside ZIP
    assert.ok(zip.file('README.txt'), 'README.txt exists inside zip');
    assert.ok(zip.file('characters/01_Captain_Jack/avatar.png'), 'Jack avatar exists inside zip');

    // Verify scenes folder is absent for old projects
    assert.ok(!zip.file('scenes/01_'), 'scenes files should not exist in zip for old projects');
    assert.ok(readmeContent.includes('本项目未使用场景参考'), 'README should note scenes were not used');
  });

  await t.test('4. Unicode, scenes, fallback views, and traversal protection in POST export-deck', async () => {
    const unicodeAndScenesScript = {
      id: 'proj-2',
      newTitle: 'ユニコードプロジェクト梅', // Japanese + CJK
      topic: 'Testing Unicode and Scenes',
      templateTitle: 'Template',
      newNarrative: {
        structure: 'Structure info',
        rhythm: 'Rhythm info',
        climaxDesign: 'Climax info',
      },
      newCharacters: [
        {
          id: 'char-unicode',
          name: '角色梅_Mei', // Chinese + Japanese
          role: '勇者🦸‍♂️👑主角', // Role with emojis (surrogate pairs)
          avatarUrl: '/uploads/avatars/mei.png',
          views: {
            front: '/uploads/views/mei_front.png',
            // side is missing
          },
          viewGenerations: {
            back: { imageUrl: '/uploads/fallback/mei_back.png' }
          }
        },
        {
          id: 'char-traversal',
          name: 'Bad Actor',
          role: 'Traverser',
          avatarUrl: '/uploads/../secret_file.png', // path traversal attempt
        }
      ],
      newShots: [
        {
          id: 'shot-u-1',
          timestamp: '00:00',
          durationSec: 3,
          description: 'First shot description text that runs long.',
          optimizedPrompt: 'prompt',
          camera: { move: 'pan', speed: 'medium', note: '' },
          framing: { shotSize: 'medium', angle: 'front' },
          cameraH: null,
          cameraV: null,
          cameraZoom: null,
          derivedFromShotId: null,
          isMaster: true,
          finalTaskId: 'task-u1',
          finalizedImageUrl: '/uploads/shot-u1.png',
          isStale: false,
          sceneId: 'scene-1', // maps to scene-1
        },
        {
          id: 'shot-u-2',
          timestamp: '00:03',
          durationSec: 2,
          description: 'Second shot description',
          optimizedPrompt: 'prompt2',
          camera: { move: 'static', speed: 'medium', note: '' },
          framing: { shotSize: 'closeup', angle: 'front' },
          cameraH: null,
          cameraV: null,
          cameraZoom: null,
          derivedFromShotId: null,
          isMaster: false,
          finalTaskId: null,
          finalizedImageUrl: null,
          isStale: false,
          sceneId: 'scene-missing', // maps to a scene that is not in references
        }
      ],
      sceneReferences: [
        {
          id: 'scene-1',
          name: '近未来都市_Tokyo', // Unicode name
          imageUrl: '/uploads/scenes/tokyo.png', // exists
          overlay: 'Tokyo Cyberpunk style overlay with long description over sixty characters to test truncation',
          updatedAt: '2026-07-15T00:00:00Z',
        },
        {
          id: 'scene-2',
          name: '无图场景_NoImage',
          // imageUrl missing
          overlay: 'Overlay 2 description',
          updatedAt: '2026-07-15T00:00:00Z',
        },
        {
          id: 'scene-3',
          name: '图不存在场景_NotExistingImage',
          imageUrl: '/uploads/scenes/non_existent.png', // path exists but file is missing
          overlay: 'Overlay 3 description',
          updatedAt: '2026-07-15T00:00:00Z',
        }
      ]
    };

    // Write mock database entry by updating the existing store row
    db.prepare("UPDATE store SET value = ? WHERE key = 'generated_scripts'").run(
      JSON.stringify([mockScript, unicodeAndScenesScript])
    );

    // Create directories and mock files
    fs.mkdirSync(path.join(tempUploadsDir, 'avatars'), { recursive: true });
    fs.mkdirSync(path.join(tempUploadsDir, 'views'), { recursive: true });
    fs.mkdirSync(path.join(tempUploadsDir, 'fallback'), { recursive: true });
    fs.mkdirSync(path.join(tempUploadsDir, 'scenes'), { recursive: true });

    fs.writeFileSync(path.join(tempUploadsDir, 'avatars', 'mei.png'), 'avatar-mei-content');
    fs.writeFileSync(path.join(tempUploadsDir, 'views', 'mei_front.png'), 'front-mei-content');
    fs.writeFileSync(path.join(tempUploadsDir, 'fallback', 'mei_back.png'), 'back-mei-content');
    fs.writeFileSync(path.join(tempUploadsDir, 'shot-u1.png'), 'shot-u1-content');
    fs.writeFileSync(path.join(tempUploadsDir, 'scenes', 'tokyo.png'), 'scene-tokyo-content');

    // Path traversal target outside tempUploadsDir (parent folder)
    const secretPath = path.resolve(tempUploadsDir, '..', 'secret_file.png');
    fs.writeFileSync(secretPath, 'secret-data');

    const req: any = {
      params: { id: 'proj-2' },
      body: { mode: 'review' },
    };
    const res = makeMockRes();

    const postHandler = routes['POST:/api/generated-scripts/:id/export-deck'];
    await postHandler(req, res);

    assert.equal(res.statusCode, 200);
    const data = res.body;
    assert.ok(data.success);

    // Verify files existence
    const pptxPath = path.join(data.exportDir, 'storyboard-deck.pptx');
    const manifestPath = path.join(data.exportDir, 'storyboard-manifest.json');
    const zipPath = path.join(data.exportDir, 'storyboard-delivery.zip');

    assert.ok(fs.existsSync(pptxPath));
    assert.ok(fs.existsSync(manifestPath));
    assert.ok(fs.existsSync(zipPath));

    // Verify ZIP file structure and entries using JSZip
    const zipData = fs.readFileSync(zipPath);
    const zip = await JSZipConstructor.loadAsync(zipData);

    // 1. Unicode character directory name decoded properly (not broken)
    assert.ok(zip.file('characters/01_角色梅_Mei/avatar.png'), 'Chinese/Unicode path avatar.png exists in zip');
    assert.ok(zip.file('characters/01_角色梅_Mei/front.png'), 'Chinese/Unicode path front.png exists in zip');

    // 2. viewGenerations fallback when views.* absent
    assert.ok(zip.file('characters/01_角色梅_Mei/back.png'), 'back.png from viewGenerations fallback exists in zip');
    assert.ok(!zip.file('characters/01_角色梅_Mei/side.png'), 'side.png is absent');

    // 3. Traversal protection: avatar of Bad Actor (traversal attempt) should NOT be exported
    assert.ok(!zip.file('characters/02_Bad_Actor/avatar.png'), 'Traversal avatar should NOT be exported');

    // 4. Scenes copy check
    assert.ok(zip.file('scenes/01_近未来都市_Tokyo.png'), 'Scene 1 image exists in zip');
    assert.ok(!zip.file('scenes/02_无图场景_NoImage.png'), 'Scene 2 has no image');
    assert.ok(!zip.file('scenes/03_图不存在场景_NotExistingImage.png'), 'Scene 3 has missing image file');

    // 5. README verification
    const readmeContent = fs.readFileSync(path.join(data.exportDir, 'README.txt'), 'utf8');
    assert.ok(readmeContent.includes('3.5 场景参考清单'));
    assert.ok(readmeContent.includes('scenes/01_近未来都市_Tokyo.png'));
    assert.ok(readmeContent.includes('无参考图'));

    // Truncated overlay snippet check
    const expectedSnippet = 'Tokyo Cyberpunk style overlay with long description over sixty characters to test truncation'.slice(0, 60);
    assert.ok(readmeContent.includes(expectedSnippet));
    assert.ok(!readmeContent.includes('aracters to test truncation')); // overlay truncated to 60 characters

    // Missing views check
    assert.ok(readmeContent.includes('缺失视图: side'));
    assert.ok(readmeContent.includes('缺失视图: avatar, front, side, back')); // Bad Actor missing all views

    // 6. Manifest verification
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.ok(manifest.scenes);
    assert.equal(manifest.scenes.length, 3);
    assert.equal(manifest.scenes[0].name, '近未来都市_Tokyo');
    assert.equal(manifest.scenes[0].imageFile, 'scenes/01_近未来都市_Tokyo.png');
    assert.equal(manifest.scenes[0].overlay, 'Tokyo Cyberpunk style overlay with long description over sixty characters to test truncation');
    assert.equal(manifest.scenes[1].imageFile, null);
    assert.equal(manifest.scenes[2].imageFile, null);

    // Shot mapping check
    assert.equal(manifest.shots[0].sceneId, 'scene-1');
    assert.equal(manifest.shots[1].sceneId, 'scene-missing');

    // Cleanup travel file
    fs.rmSync(secretPath, { force: true });
  });

  // 3. Clean up temp files
  fs.rmSync(tempUploadsDir, { recursive: true, force: true });
});
