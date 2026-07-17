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
import { truncateRole } from './generator.ts';

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

function createVideoExportFixture(
  script: any,
  videoTasks: any[],
  files: Record<string, string> = {},
) {
  const tempUploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-deck-video-test-'));
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
      createdAt TEXT NOT NULL,
      imageUrl TEXT
    );
  `);
  db.prepare("INSERT INTO store (key, value) VALUES ('generated_scripts', ?)").run(JSON.stringify([script]));
  for (const [relativePath, content] of Object.entries(files)) {
    const absPath = path.join(tempUploadsDir, relativePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
  }
  const tasks = new Map(videoTasks.map(row => [row.id, row]));
  const probeCalls: string[] = [];
  const exportEvents: Array<{
    phase: string;
    projectId: string;
    exportRelDir: string | null;
    elapsedMs: number;
  }> = [];
  const routes: Record<string, Function> = {};
  const mockApp: any = {
    get: (url: string, handler: Function) => { routes[`GET:${url}`] = handler; },
    post: (url: string, handler: Function) => { routes[`POST:${url}`] = handler; },
  };
  registerExportDeckModule(mockApp, db, {
    uploadsDir: tempUploadsDir,
    onExportPhase: event => exportEvents.push(event),
    videoDelivery: {
      getVideoTask: taskId => tasks.get(taskId),
      probeVideo: absPath => {
        probeCalls.push(absPath);
        return { width: 1088, height: 832, fps: 24, durationSec: 3.375 };
      },
    },
  });
  return {
    tempUploadsDir,
    db,
    routes,
    probeCalls,
    exportEvents,
    cleanup: () => {
      db.close();
      fs.rmSync(tempUploadsDir, { recursive: true, force: true });
    },
  };
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
        finalVideoTaskId: 'ignored-without-video-deps',
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
    assert.equal(Object.hasOwn(summary, 'finalVideos'), false, 'M2 response shape is unchanged without video deps');

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
    assert.equal(Object.hasOwn(manifest.shots[0], 'finalVideo'), false, 'M2 manifest shape is unchanged without video deps');
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
          // Role with emojis (surrogate pairs)
          // Array.from length calculation:
          // 'a' 'b' 'c' 'd' 'e' 'f' 'g' 'h' 'i' 'j' 'k' 'l' 'm' (13) + '🦸' (14) + ZWJ '\u200d' (15) + '♂' (16) + '\ufe0f' (17) + '👑' (18) = 18 code points.
          // The 14th character boundary (at index 13) lands exactly on '🦸' (the first code point of the ZWJ sequence '🦸‍♂️').
          role: 'abcdefghijklm🦸‍♂️👑',
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
        },
        {
          id: 'char-short-role',
          name: '短名角色',
          role: '勇者🦸‍♂️👑主角', // Original role with emojis, Array.from length 9 <= 14, should not be truncated
          avatarUrl: '/uploads/avatars/short.png',
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
    fs.writeFileSync(path.join(tempUploadsDir, 'avatars', 'short.png'), 'avatar-short-content');
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

    // 7. Role truncation assertions (direct test and pipeline fixture check)
    // Direct truncateRole test for the long role containing ZWJ emojis on the boundary
    const longRole = unicodeAndScenesScript.newCharacters[0].role;
    const truncated = truncateRole(longRole, 14);
    assert.ok(truncated.endsWith('…'), 'Truncated role should end with ellipsis');
    assert.equal(Array.from(truncated).length, 15, 'Truncated length should be 15');
    
    const hasIsolatedHigh = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(truncated);
    const hasIsolatedLow = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(truncated);
    assert.ok(!hasIsolatedHigh, 'Should not contain isolated high surrogate');
    assert.ok(!hasIsolatedLow, 'Should not contain isolated low surrogate');

    // Direct truncateRole test for the short role that should remain unchanged
    const shortRole = unicodeAndScenesScript.newCharacters[2].role;
    const untruncated = truncateRole(shortRole, 14);
    assert.equal(untruncated, shortRole, 'Short role should not be truncated');

    // Cleanup travel file
    fs.rmSync(secretPath, { force: true });
  });

  await t.test('5. Regression consistency test: manifest and zip scenes & characters alignment', async () => {
    // Construct project with Chinese, emojis, special characters in scene and character names
    const regressionScript = {
      id: 'proj-regression',
      newTitle: 'Regression Project',
      topic: 'Consistency Testing',
      templateTitle: 'Template',
      newNarrative: {
        structure: 'Structure',
        rhythm: 'Rhythm',
        climaxDesign: 'Climax',
      },
      newCharacters: [
        {
          id: 'char-reg-1',
          name: '角色_🔥_Char', // Chinese + Emoji + special characters
          role: 'Role A',
          avatarUrl: '/uploads/avatars/char_reg_1.png',
        }
      ],
      newShots: [
        {
          id: 'shot-reg-1',
          timestamp: '00:00',
          durationSec: 5,
          description: 'Shot 1',
          optimizedPrompt: 'Prompt 1',
          camera: { move: 'pan', speed: 'medium', note: '' },
          framing: { shotSize: 'medium', angle: 'front' },
          cameraH: null,
          cameraV: null,
          cameraZoom: null,
          derivedFromShotId: null,
          isMaster: true,
          finalTaskId: 'task-reg-1',
          finalizedImageUrl: '/uploads/shot-reg-1.png',
          isStale: false,
          sceneId: 'scene-reg-1',
        }
      ],
      sceneReferences: [
        {
          id: 'scene-reg-1',
          name: '场景_🌟_Scene', // Chinese + Emoji + special characters
          imageUrl: '/uploads/scenes/scene_reg_1.png',
          overlay: 'Overlay text',
          updatedAt: '2026-07-15T00:00:00Z',
        },
        {
          id: 'scene-reg-2',
          name: '无图场景_NoImage_🔥',
          // imageUrl missing
          overlay: 'Overlay 2',
          updatedAt: '2026-07-15T00:00:00Z',
        },
        {
          id: 'scene-reg-3',
          name: '图不存在_NotExisting_✨',
          imageUrl: '/uploads/scenes/non_existent_reg.png', // file is missing
          overlay: 'Overlay 3',
          updatedAt: '2026-07-15T00:00:00Z',
        }
      ]
    };

    // Update store with regression project
    db.prepare("UPDATE store SET value = ? WHERE key = 'generated_scripts'").run(
      JSON.stringify([mockScript, regressionScript])
    );

    // Create uploads folders & files
    fs.mkdirSync(path.join(tempUploadsDir, 'avatars'), { recursive: true });
    fs.mkdirSync(path.join(tempUploadsDir, 'scenes'), { recursive: true });

    fs.writeFileSync(path.join(tempUploadsDir, 'avatars', 'char_reg_1.png'), 'char-avatar-content');
    fs.writeFileSync(path.join(tempUploadsDir, 'shot-reg-1.png'), 'shot-1-content');
    fs.writeFileSync(path.join(tempUploadsDir, 'scenes', 'scene_reg_1.png'), 'scene-1-content');

    const req: any = {
      params: { id: 'proj-regression' },
      body: { mode: 'review' },
    };
    const res = makeMockRes();

    const postHandler = routes['POST:/api/generated-scripts/:id/export-deck'];
    await postHandler(req, res);

    assert.equal(res.statusCode, 200);
    const data = res.body;
    assert.ok(data.success);
    assert.ok(data.exportDir);

    // Verify files existence
    const manifestPath = path.join(data.exportDir, 'storyboard-manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'manifest exists');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    // Assert manifest scenes align with files in exportDir/scenes/
    assert.ok(manifest.scenes, 'scenes field exists in manifest');
    assert.equal(manifest.scenes.length, 3);

    // scene-reg-1 has valid image
    assert.equal(manifest.scenes[0].id, 'scene-reg-1');
    assert.ok(manifest.scenes[0].imageFile, 'scene-reg-1 has image file');
    const scene1FilePath = path.join(data.exportDir, manifest.scenes[0].imageFile);
    assert.ok(fs.existsSync(scene1FilePath), 'scene-reg-1 image exists on disk');
    assert.equal(fs.readFileSync(scene1FilePath, 'utf8'), 'scene-1-content');

    // scene-reg-2 has no image URL
    assert.equal(manifest.scenes[1].id, 'scene-reg-2');
    assert.equal(manifest.scenes[1].imageFile, null, 'scene-reg-2 has null imageFile');

    // scene-reg-3 has missing image file
    assert.equal(manifest.scenes[2].id, 'scene-reg-3');
    assert.equal(manifest.scenes[2].imageFile, null, 'scene-reg-3 has null imageFile');

    // Check directory check - all files in exportDir/scenes/ must be in manifest.scenes[].imageFile
    const scenesDir = path.join(data.exportDir, 'scenes');
    if (fs.existsSync(scenesDir)) {
      const filesInScenesDir = fs.readdirSync(scenesDir);
      const manifestBasenames = manifest.scenes
        .map((s: any) => s.imageFile ? path.basename(s.imageFile) : null)
        .filter((name: string | null): name is string => name !== null);
      
      for (const file of filesInScenesDir) {
        assert.ok(manifestBasenames.includes(file), `File ${file} in scenes/ must be declared in manifest`);
      }
      assert.equal(filesInScenesDir.length, manifestBasenames.length, 'Number of files in scenes/ matches manifest scenes imageFiles count');
    }

    // Character directory check: README and actual folder names must match the shared sanitizeFilename output
    const charactersDir = path.join(data.exportDir, 'characters');
    assert.ok(fs.existsSync(charactersDir), 'characters folder exists');
    const charFolders = fs.readdirSync(charactersDir);
    assert.equal(charFolders.length, 1);
    
    // Folder name should use sanitizeFilename
    const expectedCharFolder = '01_角色___Char'; // sanitized name
    assert.equal(charFolders[0], expectedCharFolder);

    // Verify README logs the correct character status and name
    const readmeContent = fs.readFileSync(path.join(data.exportDir, 'README.txt'), 'utf8');
    assert.ok(readmeContent.includes('角色_🔥_Char'), 'README contains character name');
    assert.ok(readmeContent.includes('avatar(exported)'), 'README contains avatar status');
  });

  // 3. Clean up temp files
  fs.rmSync(tempUploadsDir, { recursive: true, force: true });
});

test('final-video export revalidation maps all five missing states and copies nothing', async (t) => {
  const shot = (index: number, finalVideoTaskId: string) => ({
    id: `video-shot-${index}`,
    timestamp: `00:0${index}`,
    durationSec: 3,
    description: `Video shot ${index}`,
    optimizedPrompt: `Prompt ${index}`,
    camera: { move: 'static', speed: 'slow', note: '' },
    framing: { shotSize: 'wide', angle: 'eye-level' },
    isMaster: index === 1,
    isStale: false,
    finalVideoTaskId,
  });
  const script = {
    id: 'video-missing-project',
    newTitle: 'Missing videos',
    newNarrative: {},
    newCharacters: [],
    newShots: [
      shot(1, 'missing-task'),
      shot(2, 'wrong-shot'),
      shot(3, 'not-completed'),
      shot(4, 'not-downloaded'),
      shot(5, 'missing-file'),
    ],
  };
  const snapshot = JSON.stringify({ parameters: { durationSec: 3, fps: 24, resolution: '1152x768' } });
  const fixture = createVideoExportFixture(script, [
    { id: 'wrong-shot', shot_id: 'some-other-shot', status: 'completed', local_path: '/uploads/videos/wrong.mp4', generation_snapshot_json: snapshot },
    { id: 'not-completed', shot_id: 'video-shot-3', status: 'failed', local_path: '/uploads/videos/failed.mp4', generation_snapshot_json: snapshot },
    { id: 'not-downloaded', shot_id: 'video-shot-4', status: 'completed', local_path: null, generation_snapshot_json: snapshot },
    { id: 'missing-file', shot_id: 'video-shot-5', status: 'completed', local_path: '/uploads/videos/missing.mp4', generation_snapshot_json: snapshot },
  ]);
  t.after(fixture.cleanup);

  const checkRes = makeMockRes();
  fixture.routes['GET:/api/generated-scripts/:id/delivery-check'](
    { params: { id: script.id } },
    checkRes,
  );
  assert.deepEqual(checkRes.body.finalVideos, { count: 0, totalBytes: 0 });

  const res = makeMockRes();
  await fixture.routes['POST:/api/generated-scripts/:id/export-deck'](
    { params: { id: script.id }, body: { mode: 'review' } },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.summary.finalVideos, { present: 0, missing: 5, totalBytes: 0 });
  assert.equal(fs.existsSync(path.join(res.body.exportDir, 'videos')), false, 'default false must not create videos/');

  const manifest = JSON.parse(fs.readFileSync(path.join(res.body.exportDir, 'storyboard-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.shots.map((item: any) => item.finalVideo.reason), [
    'TAKE_NOT_FOUND',
    'TAKE_SHOT_MISMATCH',
    'TAKE_NOT_COMPLETED',
    'TAKE_NOT_DOWNLOADED',
    'TAKE_FILE_MISSING',
  ]);
  assert.ok(manifest.shots.every((item: any) => item.finalVideo.status === 'missing' && item.finalVideo.file === null));
  assert.equal(fixture.probeCalls.length, 0);

  const zip = await JSZipConstructor.loadAsync(fs.readFileSync(path.join(res.body.exportDir, 'storyboard-delivery.zip')));
  assert.equal(Object.keys(zip.files).some(name => name.startsWith('videos/') && name.endsWith('.mp4')), false);
});

test('final-video delivery uses probe output, defaults to references, and packages only when requested', async (t) => {
  const videoContent = 'fixture-mp4-content';
  const script = {
    id: 'video-ok-project',
    newTitle: 'Video delivery',
    newNarrative: {},
    newCharacters: [],
    newShots: [{
      id: 'video-shot-ok',
      timestamp: '00:00',
      durationSec: 3,
      description: 'Video shot',
      optimizedPrompt: 'Prompt',
      camera: { move: 'static', speed: 'slow', note: '' },
      framing: { shotSize: 'wide', angle: 'eye-level' },
      isMaster: true,
      isStale: false,
      finalVideoTaskId: 'take-ok',
    }],
  };
  const fixture = createVideoExportFixture(script, [{
    id: 'take-ok',
    shot_id: 'video-shot-ok',
    provider: 'agnes',
    seed: 8234022103841080,
    status: 'completed',
    local_path: '/uploads/videos/take-ok.mp4',
    normalized_size: '1152x768',
    normalized_seconds: 3.4,
    generation_snapshot_json: JSON.stringify({
      parameters: { durationSec: 3, fps: 24, resolution: '1152x768' },
    }),
  }], { 'videos/take-ok.mp4': videoContent });
  t.after(fixture.cleanup);

  const checkRes = makeMockRes();
  fixture.routes['GET:/api/generated-scripts/:id/delivery-check']({ params: { id: script.id } }, checkRes);
  assert.deepEqual(checkRes.body.finalVideos, { count: 1, totalBytes: Buffer.byteLength(videoContent) });

  const referenceOnly = makeMockRes();
  await fixture.routes['POST:/api/generated-scripts/:id/export-deck'](
    { params: { id: script.id }, body: { mode: 'review' } },
    referenceOnly,
  );
  const referenceManifest = JSON.parse(fs.readFileSync(path.join(referenceOnly.body.exportDir, 'storyboard-manifest.json'), 'utf8'));
  assert.deepEqual(referenceManifest.shots[0].finalVideo, {
    taskId: 'take-ok',
    provider: 'agnes',
    seed: 8234022103841080,
    status: 'ok',
    reason: null,
    sourcePath: '/uploads/videos/take-ok.mp4',
    file: null,
    fileBytes: Buffer.byteLength(videoContent),
    requested: { durationSec: 3, fps: 24, resolution: '1152x768' },
    actual: { width: 1088, height: 832, fps: 24, durationSec: 3.375 },
  });
  assert.equal(fs.existsSync(path.join(referenceOnly.body.exportDir, 'videos')), false);
  assert.deepEqual(referenceOnly.body.summary.finalVideos, {
    present: 1,
    missing: 0,
    totalBytes: Buffer.byteLength(videoContent),
  });

  const packaged = makeMockRes();
  await fixture.routes['POST:/api/generated-scripts/:id/export-deck'](
    { params: { id: script.id }, body: { mode: 'review', includeFinalVideos: true } },
    packaged,
  );
  const copiedVideo = path.join(packaged.body.exportDir, 'videos', 'shot-01.mp4');
  assert.equal(fs.readFileSync(copiedVideo, 'utf8'), videoContent);
  const packagedManifest = JSON.parse(fs.readFileSync(path.join(packaged.body.exportDir, 'storyboard-manifest.json'), 'utf8'));
  assert.equal(packagedManifest.shots[0].finalVideo.file, 'videos/shot-01.mp4');
  const readme = fs.readFileSync(path.join(packaged.body.exportDir, 'README.txt'), 'utf8');
  assert.ok(readme.includes('videos/'));
  assert.ok(readme.includes('1088x832 @ 24 FPS, 3.375s'));
  const zip = await JSZipConstructor.loadAsync(fs.readFileSync(path.join(packaged.body.exportDir, 'storyboard-delivery.zip')));
  assert.ok(zip.file('videos/shot-01.mp4'));
  assert.equal(fixture.probeCalls.length, 5, 'delivery-check plus two export preflight/copy rechecks use only probeVideo');
});

test('three sequential exports finish every phase and leave complete deliverables', async (t) => {
  const script = {
    id: 'repeated-export-project',
    newTitle: 'Repeated export diagnostics',
    newNarrative: {},
    newCharacters: [],
    newShots: [{
      id: 'repeated-shot-1',
      timestamp: '00:00',
      durationSec: 3,
      description: 'Static diagnostic shot',
      optimizedPrompt: 'Static diagnostic shot',
      camera: { move: 'static', speed: 'slow', note: '' },
      framing: { shotSize: 'wide', angle: 'eye-level' },
      isMaster: true,
      isStale: false,
    }],
  };
  const fixture = createVideoExportFixture(script, []);
  t.after(fixture.cleanup);

  const exportDirs: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const res = makeMockRes();
    await fixture.routes['POST:/api/generated-scripts/:id/export-deck'](
      { params: { id: script.id }, body: { mode: 'review' } },
      res,
    );
    assert.equal(res.statusCode, 200);
    exportDirs.push(res.body.exportDir);
    for (const fileName of ['storyboard-deck.pptx', 'storyboard-manifest.json', 'storyboard-delivery.zip']) {
      assert.ok(fs.statSync(path.join(res.body.exportDir, fileName)).size > 0, `${fileName} is non-empty`);
    }
  }

  assert.equal(new Set(exportDirs).size, 3, 'each export uses a distinct directory');
  const expectedPhases = [
    'started',
    'directory-ready',
    'assets-ready',
    'pptx-started',
    'pptx-written',
    'manifest-started',
    'manifest-written',
    'zip-started',
    'zip-written',
    'completed',
  ];
  assert.deepEqual(
    fixture.exportEvents.map(event => event.phase),
    [...expectedPhases, ...expectedPhases, ...expectedPhases],
  );
  assert.ok(fixture.exportEvents.every(event => (
    event.projectId === script.id
    && Number.isInteger(event.elapsedMs)
    && event.elapsedMs >= 0
    && (event.exportRelDir === null || !path.isAbsolute(event.exportRelDir))
  )));
});

test('export failure diagnostics identify the active phase without exposing an absolute export path', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-deck-failure-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const blockedUploadsPath = path.join(tempDir, 'not-a-directory');
  fs.writeFileSync(blockedUploadsPath, 'blocked');

  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE store (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare("INSERT INTO store (key, value) VALUES ('generated_scripts', ?)").run(JSON.stringify([{
    id: 'failed-export-project',
    newTitle: 'Failure diagnostics',
    newNarrative: {},
    newCharacters: [],
    newShots: [],
  }]));

  const routes: Record<string, Function> = {};
  const events: any[] = [];
  registerExportDeckModule({
    get: (url: string, handler: Function) => { routes[`GET:${url}`] = handler; },
    post: (url: string, handler: Function) => { routes[`POST:${url}`] = handler; },
  } as any, db, {
    uploadsDir: blockedUploadsPath,
    onExportPhase: event => events.push(event),
  });

  const res = makeMockRes();
  await routes['POST:/api/generated-scripts/:id/export-deck'](
    { params: { id: 'failed-export-project' }, body: { mode: 'review' } },
    res,
  );
  assert.equal(res.statusCode, 500);
  assert.deepEqual(events.map(event => event.phase), ['started', 'failed']);
  assert.equal(events[1].failedPhase, 'started');
  assert.equal(events[1].errorCode, 'ENOTDIR');
  assert.equal(events[1].exportRelDir, null);
});
