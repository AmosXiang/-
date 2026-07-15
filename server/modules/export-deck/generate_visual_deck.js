import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import util from 'node:util';
// @ts-ignore
import Database from 'better-sqlite3';
// @ts-ignore
import sharp from 'sharp';

const execPromise = util.promisify(exec);
const db = new Database('db.sqlite');

const PROJECT_ID = 'export-visual-test-project';
const UPLOADS_DIR = process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : path.resolve(process.cwd(), 'uploads');
const EVIDENCE_DIR = path.resolve(process.cwd(), 'docs/ui-redesign/tasks/evidence');
const SOFFICE_PATH = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe';

async function run() {
  console.log('--- Visual Test Deck Generation Pipeline ---');

  // 1. Create directories
  const projectUploadsDir = path.join(UPLOADS_DIR, `projects/${PROJECT_ID}`);
  fs.mkdirSync(projectUploadsDir, { recursive: true });
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  // 2. Generate dummy images using sharp
  console.log('Generating dummy images...');
  const img1Path = path.join(projectUploadsDir, 'shot-1-final.png');
  const img2Path = path.join(projectUploadsDir, 'shot-2-fallback.png');
  const img4Path = path.join(projectUploadsDir, 'shot-4-fallback.png');
  const avatarPath = path.join(UPLOADS_DIR, 'avatars', 'jack.png');
  fs.mkdirSync(path.dirname(avatarPath), { recursive: true });

  // Shot 1: Blue
  await sharp({ create: { width: 768, height: 512, channels: 3, background: { r: 59, g: 130, b: 246 } } }).png().toFile(img1Path);
  // Shot 2: Green
  await sharp({ create: { width: 768, height: 512, channels: 3, background: { r: 16, g: 185, b: 129 } } }).png().toFile(img2Path);
  // Shot 4: Purple
  await sharp({ create: { width: 768, height: 512, channels: 3, background: { r: 139, g: 92, b: 246 } } }).png().toFile(img4Path);
  // Avatar: Yellow
  await sharp({ create: { width: 128, height: 128, channels: 3, background: { r: 245, g: 158, b: 11 } } }).png().toFile(avatarPath);

  // 3. Setup mock project in DB
  console.log('Injecting mock script and comfy tasks in DB...');
  const mockScript = {
    id: PROJECT_ID,
    newTitle: '末世异能觉醒：深空曙光',
    topic: '科幻 / 废土逆袭',
    templateTitle: '经典好莱坞双雄模版',
    newNarrative: {
      structure: '非线性倒叙结构。开局展现主角梅在战役中惨烈牺牲，随后灵魂意识通过能量流重组回溯到异变爆发的前三天。梅利用已知未来开始招募盟友并收集抗体资源，并在最后一幕中成功在安全区抵挡住第一波感染体侵袭。',
      rhythm: '开场片段节奏紧凑急促，多采用快切和抖动镜头展现战场残酷。第二幕日常收集阶段节奏放缓，多为中远景展示基地筹备。',
      climaxDesign: '主角梅穿戴自主研制的初代机甲，单枪匹马在悬崖边将正在变异的感染体巨兽斩杀，晶核碎裂爆发的蓝色火光将黑夜照亮。',
    },
    newCharacters: [
      {
        id: 'char-1',
        name: '梅 (Mei)',
        role: '女主角，前科研所高级工程师，灵魂重组者。',
        avatarUrl: '/uploads/avatars/jack.png',
        views: {
          front: `/uploads/projects/${PROJECT_ID}/shot-1-final.png`,
          side: `/uploads/projects/${PROJECT_ID}/shot-2-fallback.png`,
          back: `/uploads/projects/${PROJECT_ID}/shot-4-fallback.png`,
        }
      },
      {
        id: 'char-2',
        name: '雷恩 (Reyn)',
        role: '基地守卫队长，铁血副官。',
        avatarUrl: null, // missing avatar
        views: {
          front: null,
          side: `/uploads/projects/${PROJECT_ID}/shot-2-fallback.png`,
          back: null,
        }
      },
    ],
    newShots: [
      // 1. Normal Finalized Slide
      {
        id: 'shot-1',
        timestamp: '00:00 - 00:05',
        durationSec: 5,
        description: '航拍镜头：荒凉废土中的前哨基地，风沙卷着铁锈色的落叶在空中起舞，背景中隐约能见到崩塌的太空电梯塔基。',
        optimizedPrompt: 'Cinematic wide drone shot, abandoned military outpost in reddish desert landscape, decaying sci-fi infrastructure, dramatic natural sunlight with long shadows, photorealistic, 8k resolution, desaturated color grading.',
        camera: { move: 'pan', speed: 'slow', note: '从左至右缓慢摇动' },
        framing: { shotSize: 'very wide', angle: 'high' },
        cameraH: 'high',
        cameraV: 'front',
        cameraZoom: 'wide',
        derivedFromShotId: null,
        isMaster: true,
        finalTaskId: 'task-1',
        finalizedImageUrl: `/uploads/projects/${PROJECT_ID}/shot-1-final.png`,
        isStale: false,
      },
      // 2. DRAFT Slide
      {
        id: 'shot-2',
        timestamp: '00:05 - 00:08',
        durationSec: 3,
        description: '中景：梅站在控制台前，双手快速敲击着发光的半透明数字面板，神情严峻，眼中闪过一丝焦虑。',
        optimizedPrompt: 'Medium shot of female scientist Mei interacting with holographic floating monitor in dark high-tech control room, glowing blue interface, worried expression, realistic face detail, soft dramatic backlighting.',
        camera: { move: 'push in', speed: 'medium', note: '推向面部特写' },
        framing: { shotSize: 'medium', angle: 'eye-level' },
        cameraH: 'level',
        cameraV: 'front',
        cameraZoom: 'normal',
        derivedFromShotId: 'shot-1',
        isMaster: false,
        finalTaskId: null,
        finalizedImageUrl: null,
        generatedImageUrl: `/uploads/projects/${PROJECT_ID}/shot-2-fallback.png`,
        isStale: true, // stale to test footers
      },
      // 3. No-Image Placeholder Slide
      {
        id: 'shot-3',
        timestamp: '00:08 - 00:10',
        durationSec: 2,
        description: '近景特写：警报器闪烁着刺眼的红色脉冲光芒，投射在斑驳的水泥墙壁上，灰尘在光束中漂浮。',
        optimizedPrompt: 'Macro shot of red siren light flashing on concrete wall, volumetric light beam, floating dust particles, high contrast, industrial grit.',
        camera: { move: 'static', speed: 'medium', note: '' },
        framing: { shotSize: 'close-up', angle: 'low' },
        cameraH: null,
        cameraV: null,
        cameraZoom: null,
        derivedFromShotId: null,
        isMaster: false,
        finalTaskId: null,
        finalizedImageUrl: null,
        isStale: false,
      },
      // 4. Long Text Slide (Checking truncation limit)
      {
        id: 'shot-4',
        timestamp: '00:10 - 00:15',
        durationSec: 5,
        description: '这个镜头包含一段超长描述以测试截断逻辑：警报拉响后，全基地进入一级战备状态，梅迅速穿上实验性的外骨骼战甲，气压阀喷射出白色冷凝气体。雷恩队长手持重型脉冲步枪，带领守卫小队在密闭的钢门后方列阵等待。远处传来异变野兽撞击合金装甲墙的沉闷撞击声，每一声都伴随着剧烈的震动，小队成员面色严峻，空气仿佛凝固。',
        optimizedPrompt: 'Extremely long optimized prompt test to check formatting. Futuristic command bunker interior with armored soldiers standing in defensive line behind large mechanical pressure door. Blue volumetric lights illuminate the humid air filled with fog and steam. One soldier in detailed heavy tactical power armor holds a giant laser canon. Cinematic framing, complex sci-fi scene, highly detailed, photorealistic textures, Unreal Engine 5 render style, hyper realistic faces with sweat and dirt, epic depth of field, dust particles flying, wide screen aspect ratio, masterpiece quality.',
        camera: { move: 'dynamic follow', speed: 'fast', note: '手持战甲跟随' },
        framing: { shotSize: 'medium close-up', angle: 'front' },
        cameraH: 'level',
        cameraV: 'front',
        cameraZoom: 'telephoto',
        derivedFromShotId: 'shot-1',
        isMaster: false,
        finalTaskId: null,
        finalizedImageUrl: null,
        generatedImageUrl: `/uploads/projects/${PROJECT_ID}/shot-4-fallback.png`,
        isStale: false,
      },
    ],
  };

  // Insert mock project
  const row = db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get();
  let scripts = [];
  if (row) {
    scripts = JSON.parse(row.value);
  }
  // Remove existing if any
  scripts = scripts.filter((s) => s.id !== PROJECT_ID);
  scripts.push(mockScript);
  db.prepare("INSERT OR REPLACE INTO store (key, value) VALUES ('generated_scripts', ?)").run(JSON.stringify(scripts));

  // Insert mock tasks
  db.prepare("DELETE FROM comfyui_tasks WHERE projectId = ?").run(PROJECT_ID);
  db.prepare(`
    INSERT INTO comfyui_tasks (id, projectId, targetId, targetType, viewType, status, createdAt, updatedAt, imageUrl, prompt, negativePrompt, seed, model, width, height)
    VALUES ('task-1', ?, 'shot-1', 'shot', 'main', 'succeeded', '2026-07-14T20:00:00Z', '2026-07-14T20:00:00Z', ?, 'dummy', '', '123', 'qwen', 768, 512)
  `).run(PROJECT_ID, `/uploads/projects/${PROJECT_ID}/shot-1-final.png`);

  db.prepare(`
    INSERT INTO comfyui_tasks (id, projectId, targetId, targetType, viewType, status, createdAt, updatedAt, imageUrl, prompt, negativePrompt, seed, model, width, height)
    VALUES ('task-2', ?, 'shot-2', 'shot', 'main', 'succeeded', '2026-07-14T20:00:30Z', '2026-07-14T20:00:30Z', ?, 'dummy', '', '123', 'qwen', 768, 512)
  `).run(PROJECT_ID, `/uploads/projects/${PROJECT_ID}/shot-2-fallback.png`);

  console.log('Project and tasks successfully injected.');

  // 4. Trigger Export Deck Endpoint via fetch
  console.log('Calling export-deck API endpoint...');
  const port = 3001;
  const res = await fetch(`http://localhost:${port}/api/generated-scripts/${PROJECT_ID}/export-deck`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'review' }),
  });

  const responseJson = await res.json();
  if (!responseJson.success) {
    throw new Error('Export deck failed: ' + JSON.stringify(responseJson));
  }

  const exportDir = responseJson.exportDir;
  const pptxPath = path.join(exportDir, 'storyboard-deck.pptx');
  console.log('Export deck completed successfully. PPTX path:', pptxPath);

  // 5. Render PPTX slides to PDF & PNG using LibreOffice headless
  console.log('Starting LibreOffice headless rendering to PDF...');
  try {
    const pdfCmd = `"${SOFFICE_PATH}" --headless --convert-to pdf --outdir "${EVIDENCE_DIR}" "${pptxPath}"`;
    const { stdout: pdfOut, stderr: pdfErr } = await execPromise(pdfCmd);
    console.log('LibreOffice PDF Export stdout:', pdfOut);
    if (pdfErr) console.error('LibreOffice PDF Export stderr:', pdfErr);

    console.log('Starting LibreOffice headless rendering to PNG...');
    const pngCmd = `"${SOFFICE_PATH}" --headless --convert-to png --outdir "${EVIDENCE_DIR}" "${pptxPath}"`;
    const { stdout: pngOut, stderr: pngErr } = await execPromise(pngCmd);
    console.log('LibreOffice PNG Export stdout:', pngOut);
    if (pngErr) console.error('LibreOffice PNG Export stderr:', pngErr);
  } catch (err) {
    console.error('LibreOffice execution failed:', err);
  }

  // 6. Clean up mock database records
  console.log('Cleaning up mock database records...');
  const cleanScripts = scripts.filter((s) => s.id !== PROJECT_ID);
  db.prepare("INSERT OR REPLACE INTO store (key, value) VALUES ('generated_scripts', ?)").run(JSON.stringify(cleanScripts));
  db.prepare("DELETE FROM comfyui_tasks WHERE projectId = ?").run(PROJECT_ID);

  console.log('Pipeline finished successfully. Artifacts generated in:', EVIDENCE_DIR);
}

run().catch((err) => {
  console.error('Pipeline failed:', err);
  process.exit(1);
});
