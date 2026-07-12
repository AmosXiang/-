import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { GoogleGenAI } from '@google/genai';
import { exec } from 'child_process';
import util from 'util';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import PQueue from 'p-queue';
import sharp, { type Metadata } from 'sharp';
import { registerShotAnalysisModule } from './server/modules/shot-analysis/index.ts';

const require = createRequire(import.meta.url);
const StreamPng = require('streampng-v2');

const execPromise = util.promisify(exec);

dotenv.config();

const configuredFfmpegPath = process.env.FFMPEG_PATH?.trim();
const FFMPEG_COMMAND = configuredFfmpegPath
  ? `"${configuredFfmpegPath.replace(/"/g, '\\"')}"`
  : 'ffmpeg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

export type VideoTaskRequest = {
  prompt: string;
  negativePrompt?: string;
  seed: number;
  width: number;
  height: number;
  numFrames: number;
  frameRate: number;
};

export type VideoTaskState =
  | { status: 'pending'; progress?: number }
  | { status: 'completed'; videoUrl: string }
  | { status: 'failed'; error: string };

export interface VideoProvider {
  readonly name: 'agnes' | 'seedance';
  createTask(req: VideoTaskRequest): Promise<{ providerTaskId: string; raw: unknown }>;
  pollTask(providerTaskId: string): Promise<VideoTaskState>;
}

class VideoProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly responseBody: unknown,
  ) {
    super(message);
    this.name = 'VideoProviderHttpError';
  }
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function agnesLog(event: string, details: Record<string, unknown>) {
  console.log('[VideoProvider]', JSON.stringify({
    timestamp: new Date().toISOString(),
    provider: 'agnes',
    event,
    ...details,
  }));
}

export class AgnesVideoProvider implements VideoProvider {
  readonly name = 'agnes' as const;
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    baseUrl = 'https://apihub.agnes-ai.com',
  ) {
    if (!apiKey.trim()) throw new Error('AGNES_API_KEY environment variable is not configured.');
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async createTask(req: VideoTaskRequest): Promise<{ providerTaskId: string; raw: unknown }> {
    const body = {
      model: 'agnes-video-v2.0',
      prompt: req.prompt,
      height: req.height,
      width: req.width,
      num_frames: req.numFrames,
      frame_rate: req.frameRate,
      seed: req.seed,
      ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
    };
    const startedAt = Date.now();
    agnesLog('create_request', { provider_task_id: null, method: 'POST', path: '/v1/videos', request: body });
    const response = await fetch(`${this.baseUrl}/v1/videos`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const raw = await this.readResponse(response);
    const payload = asRecord(raw);
    const providerTaskId = String(payload.video_id || payload.task_id || '');
    agnesLog('create_response', {
      provider_task_id: payload.task_id || null,
      provider_video_id: payload.video_id || null,
      status_code: response.status,
      duration_ms: Date.now() - startedAt,
      response: raw,
    });
    if (!response.ok) throw new VideoProviderHttpError(this.errorMessage(raw, response.status), response.status, raw);
    if (!providerTaskId) throw new VideoProviderHttpError('Agnes response did not include video_id or task_id.', response.status, raw);
    return { providerTaskId, raw };
  }

  async pollTask(providerTaskId: string): Promise<VideoTaskState> {
    const startedAt = Date.now();
    const pathAndQuery = `/agnesapi?video_id=${encodeURIComponent(providerTaskId)}`;
    agnesLog('poll_request', { provider_task_id: providerTaskId, method: 'GET', path: pathAndQuery });
    const response = await fetch(`${this.baseUrl}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    const raw = await this.readResponse(response);
    const payload = asRecord(raw);
    agnesLog('poll_response', {
      provider_task_id: providerTaskId,
      status_code: response.status,
      duration_ms: Date.now() - startedAt,
      provider_status: payload.status || null,
      response: raw,
    });

    if (response.status === 503 || response.status >= 500) return { status: 'pending', progress: this.progress(payload.progress) };
    if (!response.ok) return { status: 'failed', error: this.errorMessage(raw, response.status) };

    const status = String(payload.status || '').toLowerCase();
    if (status === 'failed') return { status: 'failed', error: this.errorMessage(payload.error || raw, response.status) };
    if (status === 'completed') {
      // UNVERIFIED: Agnes currently exposes the final MP4 in the misleading
      // remixed_from_video_id field. Alternative fields are tolerated because
      // the provider documentation warns that this response shape may change.
      const videoUrl = payload.remixed_from_video_id
        || payload.video_url
        || payload.url
        || payload.output?.video_url
        || payload.output?.url;
      if (!videoUrl || typeof videoUrl !== 'string') {
        return { status: 'failed', error: 'Agnes completed response did not include a recognized video URL.' };
      }
      return { status: 'completed', videoUrl };
    }
    return { status: 'pending', progress: this.progress(payload.progress) };
  }

  private async readResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return { raw_text: text }; }
  }

  private errorMessage(raw: unknown, status: number): string {
    const payload = asRecord(raw);
    const error = asRecord(payload.error);
    return String(error.message || error.detail || payload.message || payload.detail || `Agnes request failed with HTTP ${status}`);
  }

  private progress(value: unknown): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
}

// Ensure directories exist
const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Initialize SQLite Database
const dbSqlite = new Database(process.env.SQLITE_DB_PATH ? path.resolve(process.env.SQLITE_DB_PATH) : path.join(__dirname, 'db.sqlite'));
dbSqlite.exec(`
  CREATE TABLE IF NOT EXISTS store (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);
dbSqlite.exec(`
  CREATE TABLE IF NOT EXISTS comfyui_tasks (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    targetId TEXT NOT NULL,
    targetType TEXT NOT NULL,
    viewType TEXT NOT NULL,
    shotIndex INTEGER,
    characterName TEXT,
    prompt TEXT NOT NULL,
    negativePrompt TEXT NOT NULL,
    seed TEXT NOT NULL,
    model TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    status TEXT NOT NULL,
    retryCount INTEGER DEFAULT 0,
    retryOfTaskId TEXT,
    supersededByTaskId TEXT,
    error TEXT,
    imageUrl TEXT,
    apiWorkflowJson TEXT,
    uiWorkflowJson TEXT,
    missingSince TEXT,
    recoveryCheckCount INTEGER DEFAULT 0,
    createdAt TEXT NOT NULL,
    submittedAt TEXT,
    completedAt TEXT,
    characterReferenceImageUrl TEXT,
    characterReferenceTaskId TEXT,
    lockCharacterIdentity INTEGER NOT NULL DEFAULT 1,
    batchOrder INTEGER,
    updatedAt TEXT NOT NULL
  )
`);
dbSqlite.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON comfyui_tasks (status, createdAt)`);
dbSqlite.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project_updated ON comfyui_tasks (projectId, updatedAt)`);
dbSqlite.exec(`
  CREATE TABLE IF NOT EXISTS comfyui_shot_batches (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    regenerateMode TEXT NOT NULL,
    status TEXT NOT NULL,
    totalCount INTEGER NOT NULL DEFAULT 0,
    queuedCount INTEGER NOT NULL DEFAULT 0,
    enqueueFailedCount INTEGER NOT NULL DEFAULT 0,
    errorsJson TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    stoppedAt TEXT
  )
`);
dbSqlite.exec(`CREATE INDEX IF NOT EXISTS idx_shot_batches_project_created ON comfyui_shot_batches (projectId, createdAt)`);
dbSqlite.exec(`
  CREATE TABLE IF NOT EXISTS comfyui_shot_batch_items (
    id TEXT PRIMARY KEY,
    batchId TEXT NOT NULL,
    projectId TEXT NOT NULL,
    targetId TEXT NOT NULL,
    shotIndex INTEGER NOT NULL,
    batchOrder INTEGER NOT NULL,
    taskId TEXT,
    matchedCharactersJson TEXT NOT NULL DEFAULT '[]',
    workflowPresetId TEXT,
    characterReferenceImageUrl TEXT,
    workflowInjected INTEGER NOT NULL DEFAULT 0,
    finalStatus TEXT NOT NULL,
    error TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )
`);
dbSqlite.exec(`CREATE INDEX IF NOT EXISTS idx_shot_batch_items_batch_order ON comfyui_shot_batch_items (batchId, batchOrder)`);

// Backward-compatible ComfyUI manual-import migration. Existing rows remain queue-originated.
const comfyTaskColumns = new Set(
  (dbSqlite.prepare('PRAGMA table_info(comfyui_tasks)').all() as Array<{ name: string }>).map(column => column.name)
);
if (!comfyTaskColumns.has('origin')) {
  dbSqlite.exec("ALTER TABLE comfyui_tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'queue'");
}
if (!comfyTaskColumns.has('importedFromTaskId')) {
  dbSqlite.exec('ALTER TABLE comfyui_tasks ADD COLUMN importedFromTaskId TEXT');
}
if (!comfyTaskColumns.has('workflowPresetId')) {
  dbSqlite.exec('ALTER TABLE comfyui_tasks ADD COLUMN workflowPresetId TEXT');
}
if (!comfyTaskColumns.has('workflowFamily')) {
  dbSqlite.exec('ALTER TABLE comfyui_tasks ADD COLUMN workflowFamily TEXT');
}
if (!comfyTaskColumns.has('workflowBatchId')) {
  dbSqlite.exec('ALTER TABLE comfyui_tasks ADD COLUMN workflowBatchId TEXT');
}
if (!comfyTaskColumns.has('sourceImageUrl')) {
  dbSqlite.exec('ALTER TABLE comfyui_tasks ADD COLUMN sourceImageUrl TEXT');
}
if (!comfyTaskColumns.has('sourceTaskId')) {
  dbSqlite.exec('ALTER TABLE comfyui_tasks ADD COLUMN sourceTaskId TEXT');
}
if (!comfyTaskColumns.has('outputNodeId')) {
  dbSqlite.exec('ALTER TABLE comfyui_tasks ADD COLUMN outputNodeId TEXT');
}
if (!comfyTaskColumns.has('presetParametersJson')) {
  dbSqlite.exec('ALTER TABLE comfyui_tasks ADD COLUMN presetParametersJson TEXT');
}
if (!comfyTaskColumns.has('characterReferenceImageUrl')) {
  dbSqlite.exec('ALTER TABLE comfyui_tasks ADD COLUMN characterReferenceImageUrl TEXT');
}
if (!comfyTaskColumns.has('characterReferenceTaskId')) {
  dbSqlite.exec('ALTER TABLE comfyui_tasks ADD COLUMN characterReferenceTaskId TEXT');
}
if (!comfyTaskColumns.has('lockCharacterIdentity')) {
  dbSqlite.exec('ALTER TABLE comfyui_tasks ADD COLUMN lockCharacterIdentity INTEGER NOT NULL DEFAULT 1');
}
if (!comfyTaskColumns.has('batchOrder')) {
  dbSqlite.exec('ALTER TABLE comfyui_tasks ADD COLUMN batchOrder INTEGER');
}
if (!comfyTaskColumns.has('comfyPromptId')) {
  dbSqlite.exec('ALTER TABLE comfyui_tasks ADD COLUMN comfyPromptId TEXT');
}
if (!comfyTaskColumns.has('queuePosition')) {
  dbSqlite.exec('ALTER TABLE comfyui_tasks ADD COLUMN queuePosition INTEGER');
}
if (!comfyTaskColumns.has('stateDetail')) {
  dbSqlite.exec('ALTER TABLE comfyui_tasks ADD COLUMN stateDetail TEXT');
}

dbSqlite.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_comfy_manual_import_unique
  ON comfyui_tasks (importedFromTaskId, importSha256)
  WHERE origin = 'manual_import'
`);

// Concurrent write queue
const writeQueue = new PQueue({ concurrency: 1 });

async function mutateDb(mutator: (db: any) => void | Promise<void>) {
  return writeQueue.add(async () => {
    const db = readDb();
    await mutator(db);
    writeDb(db);
  });
}

app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));

// Setup multer for local file uploading
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 1024 * 1024 * 500 // 500MB limit for local upload
  }
});

const DEMO_TEMPLATE = {
  narrative: {
    structure: "ç”±ä¸‰ä¸ªä¸»è¦ç©ºé—´ï¼ˆé£žç©ºèˆ±èˆ±ã€ä¸‡ç±³äº‘ç©ºã€å¼‚åŸŸé›ªå±±ä¸Žæ·±æµ·ç³–æžœç•Œï¼‰æž„æˆçš„å››å¹•å¼æ—¶ç©ºç©¿æ¢­ç»“æž„ï¼Œé€šè¿‡é»‘è‰²æ¼©æ¶¡ä¼ é€é—¨åˆ‡æ¢åœºæ™¯ï¼Œè¡¨çŽ°å°é˜Ÿä»Žæ—¥å¸¸æ‹Œå˜´åˆ°ååŒå è½ã€å†åˆ°æ—¶ç©ºå¤§åå·®çŽ¯å¢ƒæ»‘ç¨½è‡ªæ•‘ï¼Œæœ€ç»ˆåœ¨è¿œå¤é—è¿¹åºŸå¢Ÿä¸Žå¼‚å½¢æ€ªå…½å†³æˆ˜çš„å™äº‹èµ·ä¼ã€‚",
    rhythm: "è§†å¬ä¸Šï¼Œå‰æ®µä»¥èˆ±å†…è·Ÿæ‹å¯¹è¯ä¸ºä¸»ï¼Œåˆ©ç”¨å¿«èŠ‚å¥æ—¥å¸¸æ‹Œå˜´å»ºç«‹ç¾ç»Šï¼›ä¸­æ®µè‡ªèˆ±é—¨å¤§å¼€è½¬ä¸ºé«˜é€Ÿè‡ªç”±è½ä½“çš„é«˜ç©ºæƒŠé™©ä¿¯ä»°è·Ÿæ‹ä¸Žç¬¬ä¸€äººç§°æžé€Ÿç©¿æ¢­ï¼ŒéŸ³ä¹ä»Žæ¬¢å¿«æ—¥å¸¸è½¬ä¸ºéœ‡æ’¼æ¢å¼˜ï¼›åŽåŠæ®µä»¥ä¸åŒé‡åŠ›/ç‰©è´¨çŽ¯å¢ƒï¼ˆé›ªå±±æ»‘é›ªã€æ·±æµ·ç‰©è´¨è½¬åŒ–ã€ç³–æžœçŽ‹å›½é²œè‰³æ³¢æ™®ã€æ²™æ¼ åºŸå¢Ÿå†³æˆ˜ï¼‰è¿›è¡Œå¿«é€Ÿäº¤å‰å‰ªè¾‘å’Œå®šæ ¼å‰ªè¾‘ï¼Œäº§ç”Ÿæžä½³çš„è’è¯žçˆ†ç¬‘ä¸Žçƒ­è¡€å¯¹æŠ—çš„èµ·ä¼è½å·®ã€‚",
    climaxDesign: "çˆ½ç‚¹ä½ç½®è®¾ç½®åœ¨ï¼š1. å°‘å¥³å¸…æ°”åŽä»°è·ƒä¸‹èˆ±é—¨çš„åŠ¨ä½œé«˜æ½®ï¼›2. ä¸¤ä¸ªå¤§ç”·äººåœ¨é›ªå´©ä¸­ç‹¼ç‹ˆç¿»æ»šçš„æ»‘ç¨½æžç¬‘å†²çªç‚¹ï¼›3. ç©¿è¶Šç³–æžœç•ŒåŽçš„è§†è§‰ä¸ŽéŸ³å“ç‹‚æ¬¢ï¼›4. æ²™æ¼ é—è¿¹åºŸå¢Ÿé¡¶ç«¯åˆåŠ›å‡»æ€è¶…å·¨åž‹å¼‚å½¢é¢†ä¸»æ—¶çš„çƒ­è¡€çˆ½æ„Ÿçˆ†å‘ç‚¹ã€‚"
  },
  characters: [
    { name: "ç¥žç§˜å°‘å¥³", role: "ä¸»è§’/é¢†èˆªè€…", personality: "æžœæ–­ã€å†·é…·è…¹é»‘ã€æ‹¥æœ‰å¬å”¤ä¼ é€é—¨çš„ç‰¹æ®Šå¼‚èƒ½ï¼Œå–œæ¬¢åæ§½å’Œçœ‹æˆ", clothing: "é»‘å‘ã€é«˜åº•é•¿é´ã€è’¸æ±½æœ‹å…‹é£Žæœºæ¢°æŒ‚é¥°çš®è¡£" },
    { name: "èµ«ä¼¯ç‰¹æ•™æŽˆ", role: "çŸ¥è¯†æ‹…å½“/æžç¬‘æ‹…å½“", personality: "è‡ªå°Šå¿ƒæžå¼ºã€è¯ç—¨ã€å‚²å¨‡å˜´ç¡¬ã€æœ‰æé«˜ç—‡ä¸”è®¤æ­»ç†", clothing: "é‡‘å±žæ¡†å•ç‰‡çœ¼é•œã€å¤å¤å‘¢å­å¤§è¡£ã€ä¾¿æºå¼æ°”åŽ‹ç½—ç›˜" },
    { name: "å·´æ‰Žå°” (Bearded Warrior)", role: "æˆ˜åŠ›æ‹…å½“/å¸‚äº•è°ƒå‰‚", personality: "è±ªçˆ½ä¸ç¾ã€ç¥žç»ç²—å¤§ã€é‡Žæ€§æ±‚ç”Ÿæ¬²æžå¼ºã€çˆ±è´ªä¾¿å®œçš„ç»œè…®èƒ¡æˆ˜å£«", clothing: "å…½çš®æŠ¤è‚©ã€ç£¨æŸä¸¥é‡çš„é»„é“œåŠèº«èƒ¸ç”²ã€è…°æŒ‚çŸ­æŸ„æ–§" }
  ],
  shots: [
    { timestamp: "00:00 - 00:07", timeSeconds: 3, movement: "å…¨æ™¯èˆªæ‹è½¬å€¾æ–œä¿¯å†²", composition: "å¯¹ç§°æž„å›¾åŠä¸‹ä¸‰åˆ†æ³•æž„å›¾", emotion: "éœ‡æ’¼ã€å£®ä¸½ã€å……æ»¡å†’é™©å²è¯—æ„Ÿ", description: "ä¸€è‰˜å·¨å¤§çš„è’¸æ±½é£žç©ºè‰‡åœ¨ç™½äº‘ç¼­ç»•çš„å´‡å±±å³»å²­é—´é£žè¡Œï¼ŒéšåŽé•œå¤´åž‚ç›´å‘ä¸‹ï¼Œä¿¯å†²å±•çŽ°é£žç©ºè‰‡çš„åŠ¨åŠ›æŽ¨è¿›è£…ç½®ï¼Œå¥ å®šäº†å½±ç‰‡å®å¤§çš„å¥‡å¹»å·¥ä¸šä¸–ç•Œè§‚ã€‚" },
    { timestamp: "00:07 - 00:27", timeSeconds: 15, movement: "ä½Žè§’åº¦è„šæ­¥è·Ÿæ‹è‡³èˆ±å†…æŽ¨è½¨", composition: "åˆ©ç”¨ä¸¤ä¾§é‡‘å±žé˜€é—¨ä¸Žèˆ±å£å½¢æˆæ±‡èšçº¿/æ¡†æž¶æž„å›¾", emotion: "ç¥žç§˜ã€æ²‰é—·ã€æš—æµæ¶ŒåŠ¨", description: "èˆ±å†…æ˜æš—ä¸”å……æ»¡é‡‘å±žæ„Ÿï¼Œç¥žç§˜çš„é»‘å‘å°‘å¥³åœ¨å‰æ–¹èµ°ï¼Œæ²‰é‡çš„åŽšåº•é•¿é´å‘å‡ºå›žéŸ³ã€‚åŒè¡Œçš„èµ«ä¼¯ç‰¹æ•™æŽˆæ­£åœ¨æ¿€çƒˆåœ°æŠ±æ€¨å› è¿·è·¯è€½è¯¯äº†åäºŒåˆ†é’Ÿã€‚" },
    { timestamp: "00:27 - 00:40", timeSeconds: 32, movement: "ä¸­æ™¯å¯¹è¯ç»“åˆè§’è‰²é¢éƒ¨ç‰¹å†™", composition: "é»„é‡‘åˆ†å‰²ç‚¹æž„å›¾ï¼Œèšç„¦æ•™æŽˆé¢éƒ¨ç»†èŠ‚", emotion: "é£Žè¶£ã€è¾©è®ºæ°”æ°›ã€æ—¥å¸¸æ‹Œå˜´", description: "èµ«ä¼¯ç‰¹æ•™æŽˆå˜´ç¡¬æŽ¨çœ¼é•œï¼Œå®£ç§°è‡ªå·±çš„ä¼ªè£…è®¡åˆ’å®Œç¾Žæ— ç‘•ã€‚å·´æ‰Žå°”æ— æƒ…æˆ³ç©¿ï¼šä½ æŠŠä¼ªé€ çš„å•å­äº¤ç»™äº†ä¸€ä¸ªä¸è¯†å­—ã€ç”šè‡³æŠŠçº¸æ‹¿åäº†çš„å®ˆå«ï¼" },
    { timestamp: "00:40 - 00:57", timeSeconds: 48, movement: "å®šæœºä½åŒäººç‰¹å†™", composition: "å¼ºçƒˆçš„å·¦å³å¯¹æ¯”æž„å›¾ï¼Œä¸€ç³™ä¸€é›…å½¢æˆå¿ƒç†è½å·®", emotion: "è’è¯žå–œæ„Ÿã€å«Œå¼ƒ", description: "å·´æ‰Žå°”æ¯«ä¸åœ¨æ„åœ°ç”¨æ‰‹æŒ‡æŒ–èµ·é¼»å­”ï¼Œæ•™æŽˆæ„Ÿåˆ°æžå¤§ç”Ÿç†ä¸é€‚ã€‚è´¨é—®ä»–æ˜¯å¦åœ¨ç”¨æ‰‹æŒ‡æŒ–é¼»å­ï¼Œå·´æ‰Žå°”åè®½è¯´éš¾é“åº”è¯¥ç”¨å‰å­ï¼Œæ•™æŽˆåˆ™è¦æ±‚ä»–ä¿æŒâ€˜åŸºæœ¬æ–‡æ˜Žâ€™ã€‚" },
    { timestamp: "00:57 - 01:13", timeSeconds: 65, movement: "é€šé“é€è§†æ‹‰æŽ¨é•œ", composition: "ä¸‰åˆ†æ³•ã€é€šé“é€è§†ï¼Œç¯å…‰æ‘‡æ›³", emotion: "è¯™è°ã€å¸‚äº•å†’é™©æ°”", description: "èˆ±é¡¶æ°”é˜€å–·å‡ºè’¸æ±½ï¼ŒåŠç¯å‰§çƒˆæ™ƒåŠ¨ã€‚å·´æ‰Žå°”å¬‰çš®ç¬‘è„¸è¯´ä»–åœ¨â€˜å¯»æ‰¾å®è—â€™ã€‚æ•™æŽˆåæ§½â€˜åœ¨é¼»å­é‡Œï¼Ÿâ€™å·´æ‰Žå°”å›žæ•¬â€˜åœ¨é‡Œé¢æ‰¾åˆ°çš„ä¸œè¥¿æ¯”ä½ å‰ä¸‰å¼ åœ°å›¾è¿˜è¦å¤šï¼â€™" },
    { timestamp: "01:13 - 01:31", timeSeconds: 80, movement: "é«˜ä½Žä½åž‚ç›´è·Ÿæ‹", composition: "çºµå‘åž‚ç›´åˆ†å‰²ç”»é¢ï¼Œå°‘å¥³æ²¿æ¢¯å­ä¸‹è¡Œ", emotion: "æ¬¢ä¹ã€ç›¸äº’åæ§½ã€ç¾ç»ŠåŠ æ·±", description: "å°‘å¥³æ²¿é“æ¢¯è½»ç›ˆèµ°ä¸‹ï¼Œæ•™æŽˆç»§ç»­è¾“å‡ºï¼šâ€˜å¦‚æžœè°æ´»å¾—åƒé‡Žå…½ï¼Œç»å¯¹æ˜¯ä½ ï¼Œè¿˜è®°å¾—åƒç”Ÿè‚‰é‚£æ¬¡å—ï¼Ÿâ€™å·´æ‰Žå°”ä¸ç”˜ç¤ºå¼±ï¼šâ€˜é‚£æ˜¯è›‹ç™½è´¨ï¼ä½ åªæ˜¯å«‰å¦’æˆ‘èƒ½æ¶ˆåŒ–ã€‚â€™" },
    { timestamp: "01:31 - 01:56", timeSeconds: 105, movement: "ç¬¬ä¸€äººç§°å¼€é—¨åˆ°å¹¿è§’æ‘‡æ‘„", composition: "æ¡†å¼é€†å…‰ï¼Œåœ°å¹³çº¿å¤„äºŽä¸­ä¸‹æ®µï¼Œäº‘æµ·åœ¨é˜³å…‰ä¸‹æ³¢æ¾œå£®é˜”", emotion: "å¿ƒæ—·ç¥žæ€¡ã€æ³¢æ¾œå£®é˜”ã€å±æœºä¸´è¿‘", description: "å°‘å¥³åˆ©è½æ‹‰å¼€æ²‰é‡èˆ±é—¨ï¼Œç‹‚é£Žå¤§ä½œã€‚å¤–é¢æ˜¯é«˜è¾¾ä¸‡ç±³çš„é«˜ç©ºäº‘æµ·ï¼Œè¿œå¤„æ¼‚æµ®ç€ä¸€è‰˜é£žç©ºå¸†èˆ¹ã€‚å°‘å¥³å›žå¤´æŠ›ä¸‹ä¸€å¥â€˜ä¸‹åŽ»çš„æ—¶å€™å°½é‡åˆ«å«â€™ï¼Œååˆ†æŒ‘è¡…ã€‚" },
    { timestamp: "01:56 - 02:07", timeSeconds: 118, movement: "é«˜é€Ÿè‡ªç”±è½ä½“è·Ÿæ‹", composition: "ä¿¯ä»°è§†å·®ï¼Œå°‘å¥³å±…ä¸­ï¼Œæ”¾å°„çº¿æµçº¿çº¿æ¡", emotion: "æƒŠé™©ã€ç‹‚æ”¾ã€è‡ªç”±æ„Ÿ", description: "å°‘å¥³å¼ å¼€åŒè‡‚ï¼Œä¼˜é›…åœ°å‘äº‘æµ·ä»°é¢å ä¸‹ï¼ŒåŠ¨ä½œæ½‡æ´’å®Œç¾Žã€‚å·´æ‰Žå°”åœ¨ç”²æ¿è¾¹å“ˆå“ˆå¤§ç¬‘èµžå¹â€˜è¿™æ‰æ˜¯æˆ‘æ¬£èµçš„å¥³äººï¼â€™ï¼Œå¹¶æˆè°‘æ•™æŽˆæ˜¯ä¸æ˜¯æé«˜ã€‚" },
    { timestamp: "02:07 - 02:25", timeSeconds: 135, movement: "é•œå¤´æ€¥é€ŸæŽ¨æ‹‰ä¸Žæžç¬‘å®šæ ¼", composition: "æ•™æŽˆä¾§èº«è¿‘æ™¯ï¼Œå·´æ‰Žå°”çªç„¶æ¶ˆå¤±æ‰“ç ´å¹³è¡¡", emotion: "æ»‘ç¨½ã€å¼ºä½œé•‡å®šã€è®¤å‘½", description: "æ•™æŽˆå˜´ç¡¬ï¼šâ€˜æˆ‘åªæ˜¯åœ¨è®¡ç®—æœ€ä½³é™è½è§’åº¦ï¼â€™å·´æ‰Žå°”å¤§å¼â€˜é‚£ä½ åŽ»ç®—ç®—è¿™ä¸ªå§ï¼â€™è¯´å®ŒåŽä»°å°–å«è·³ä¸‹ã€‚æ•™æŽˆç»æœ›è‡ªè¯­â€˜æˆ‘è®¨åŽŒè¿™ä¸ªé˜Ÿä¼â€™ï¼Œä¹Ÿæ— å¥ˆè·ƒä¸‹ã€‚" },
    { timestamp: "02:25 - 03:24", timeSeconds: 165, movement: "é«˜ç©ºå¹³è¡Œæ‘‡æ‘†è·Ÿæ‹", composition: "å¹¶åˆ—é£žè¡Œï¼Œé£Žé˜»å½¢å˜ï¼ŒèƒŒæ™¯æ˜¯æ— é™…è”šè“å’Œç™½äº‘", emotion: "æžåº¦äº¢å¥‹ã€å¼ºçƒˆçš„é€Ÿåº¦å’Œå¤±é‡å†²å‡»", description: "ä¸‰äººå¦‚åŒé¸Ÿå„¿èˆ¬ç©¿è¿‡äº‘æµ·ã€‚å·´æ‰Žå°”å¤§å¼â€˜è¿™æ‰æ˜¯ç”Ÿæ´»ï¼â€™ï¼Œå¹¶ç–¯ç‹‚å˜²ç¬‘è„¸è‰²ç…žç™½ã€è¿˜åœ¨æ‰‹å¿™è„šä¹±å¼ºè£…â€˜ä¸€åˆ‡å°½åœ¨æŽŒæ¡â€™çš„æ•™æŽˆã€‚å°‘å¥³åˆ™åœ¨ä¸€æ—ä¼˜é›…æ»‘è¡Œã€‚" },
    { timestamp: "03:24 - 03:39", timeSeconds: 210, movement: "ç‰¹æ•ˆç©¿è¶Šå¿«æ‘‡", composition: "æ–œå‘å¯¹è§’çº¿æž„å›¾ï¼Œæ´ç™½é›ªå±±ä¸Žé»‘è‰²é£Žæš´ä¼ é€é—¨å¯¹æ’ž", emotion: "æžé€Ÿä¸æ»‘ã€çŽ¯å¢ƒå¼‚æ ·çš„éœ‡æ’¼", description: "å°‘å¥³åœ¨ç©ºä¸­å‡­ç©ºå¬å”¤ä¸€ä¸ªé»‘è‰²æ¼©æ¶¡ä¼ é€é—¨ï¼Œç©¿è¿‡åŽçž¬é—´è½åœ¨ä¸€åº§å·å³¨çš„é›ªå±±ä¸Šï¼Œå¥¹å‡­å€Ÿé‡é´å¦‚åŒæ»‘é›ªæ¿ä¸€èˆ¬åœ¨é™¡å³­é›ªå¡ä¸Šæžé€Ÿç”»å¼§æ»‘è¡Œã€‚" },
    { timestamp: "03:39 - 03:55", timeSeconds: 228, movement: "åŠ¨æ€å‰ªè¾‘å¯¹æ¯”", composition: "å·¦åŠè¾¹å°‘å¥³è½»çµæ»‘è¡Œï¼Œå³åŠè¾¹ä¸¤äººç‹¼ç‹ˆç¿»æ»š", emotion: "æ»‘ç¨½æžç¬‘ã€æƒŠé™©ä¸‡åˆ†", description: "ä¸¤ä¸ªå¤§ç”·äººä»Žä¼ é€é—¨æ»šè½ç ¸è¿›é›ªå †ï¼Œæƒ¨é­é›ªå´©å¼ç¿»æ»šã€‚æ•™æŽˆç»æœ›æƒ¨å«â€˜è¿™ä¸å«å‡é€Ÿï¼è¿™åªæ˜¯æ¢äº†ä¸ªå§¿åŠ¿å¾€ä¸‹æŽ‰ï¼â€™ï¼Œå·´æ‰Žå°”å˜´ç¡¬â€˜æ€»æ¯”èµ°è·¯å¼ºï¼â€™" }
  ]
};

// Helper: read db
function readDb() {
  // 1. One-time migration from db.json if it exists
  const oldDbPath = path.join(__dirname, 'db.json');
  if (fs.existsSync(oldDbPath)) {
    try {
      console.log('[SQLite Migration] Found legacy db.json. Migrating to SQLite...');
      const content = fs.readFileSync(oldDbPath, 'utf8');
      const parsed = JSON.parse(content);
      const migrated = Array.isArray(parsed) ? { videos: parsed, generated_scripts: [] } : parsed;

      const stmt = dbSqlite.prepare('INSERT OR REPLACE INTO store (key, value) VALUES (?, ?)');
      stmt.run('videos', JSON.stringify(migrated.videos || []));
      stmt.run('generated_scripts', JSON.stringify(migrated.generated_scripts || []));

      fs.unlinkSync(oldDbPath);
      console.log('[SQLite Migration] Successfully migrated and deleted db.json');
    } catch (e) {
      console.error('[SQLite Migration] Failed to migrate db.json:', e);
    }
  }

  try {
    const getStmt = dbSqlite.prepare('SELECT value FROM store WHERE key = ?');
    const videosRow = getStmt.get('videos') as { value: string } | undefined;
    const scriptsRow = getStmt.get('generated_scripts') as { value: string } | undefined;

    const parsed = {
      videos: videosRow ? JSON.parse(videosRow.value) : [],
      generated_scripts: scriptsRow ? JSON.parse(scriptsRow.value) : []
    };

    // Helper to migrate Pollinations absolute URLs to local proxy format
    const migrateUrl = (url: string | undefined, defaultWidth = '512', defaultHeight = '768'): string | undefined => {
      if (!url) return url;
      const match = url.match(/^https?:\/\/image\.pollinations\.ai\/prompt\/([^?]+)/);
      if (match) {
        const promptPart = match[1];
        let width = defaultWidth;
        let height = defaultHeight;
        try {
          const urlObj = new URL(url);
          width = urlObj.searchParams.get('width') || defaultWidth;
          height = urlObj.searchParams.get('height') || defaultHeight;
        } catch (e) {
          // Fallback if URL parsing fails
        }
        return `/api/pollinations-proxy?prompt=${promptPart}&width=${width}&height=${height}`;
      }
      return url;
    };

    let modified = false;
    if (parsed.generated_scripts) {
      for (const script of parsed.generated_scripts) {
        // 1. Migrate shots images
        if (script.newShots) {
          for (const shot of script.newShots) {
            const oldImg = shot.imageUrl;
            const oldGenImg = shot.generatedImageUrl;

            shot.imageUrl = migrateUrl(shot.imageUrl, '768', '512');
            shot.generatedImageUrl = migrateUrl(shot.generatedImageUrl, '768', '512');

            if (shot.imageUrl !== oldImg || shot.generatedImageUrl !== oldGenImg) {
              modified = true;
            }
          }
        }
        // 2. Migrate characters views & avatar
        if (script.newCharacters) {
          for (const char of script.newCharacters) {
            const oldAvatar = char.avatarUrl;
            char.avatarUrl = migrateUrl(char.avatarUrl, '512', '768');
            if (char.avatarUrl !== oldAvatar) {
              modified = true;
            }

            if (char.views) {
              for (const key of ['front', 'side', 'back'] as const) {
                const oldView = char.views[key];
                char.views[key] = migrateUrl(char.views[key], '512', '768') || '';
                if (char.views[key] !== oldView) {
                  modified = true;
                }
              }
            }
          }
        }
      }
    }

    if (modified) {
      console.log('[DB Migration] Automatically migrated absolute Pollinations URLs.');
      const stmt = dbSqlite.prepare('INSERT OR REPLACE INTO store (key, value) VALUES (?, ?)');
      stmt.run('videos', JSON.stringify(parsed.videos));
      stmt.run('generated_scripts', JSON.stringify(parsed.generated_scripts));
    }

    return parsed;
  } catch (err) {
    console.error('Error reading DB:', err);
    return { videos: [], generated_scripts: [] };
  }
}

// Helper: write db
function writeDb(data: any) {
  try {
    const stmt = dbSqlite.prepare('INSERT OR REPLACE INTO store (key, value) VALUES (?, ?)');
    stmt.run('videos', JSON.stringify(data.videos || []));
    stmt.run('generated_scripts', JSON.stringify(data.generated_scripts || []));
  } catch (err) {
    console.error('Error writing DB:', err);
  }
}

// Helper: one-time static migration to ensure all existing shots/characters have UUIDs
function migrateDatabaseIds() {
  console.log('[SQLite Migration] Checking for missing Shot/Character IDs...');
  try {
    const getStmt = dbSqlite.prepare('SELECT value FROM store WHERE key = ?');
    const scriptsRow = getStmt.get('generated_scripts') as { value: string } | undefined;
    if (!scriptsRow) return;

    const generated_scripts = JSON.parse(scriptsRow.value);
    if (!Array.isArray(generated_scripts)) return;

    let modified = false;
    for (const script of generated_scripts) {
      if (script.newShots) {
        for (const shot of script.newShots) {
          if (!shot.id) {
            shot.id = crypto.randomUUID();
            modified = true;
          }
        }
      }
      if (script.newCharacters) {
        for (const char of script.newCharacters) {
          if (!char.id) {
            char.id = crypto.randomUUID();
            modified = true;
          }
        }
      }
    }

    if (modified) {
      console.log('[SQLite Migration] Found missing IDs. Performing atomic migration transaction...');
      const transaction = dbSqlite.transaction(() => {
        const updateStmt = dbSqlite.prepare('INSERT OR REPLACE INTO store (key, value) VALUES (?, ?)');
        updateStmt.run('generated_scripts', JSON.stringify(generated_scripts));
      });
      transaction();
      console.log('[SQLite Migration] Database ID migration complete.');
    } else {
      console.log('[SQLite Migration] All Shot/Character IDs are up to date.');
    }
  } catch (err) {
    console.error('[SQLite Migration Error]', err);
  }
}


// Helper: optimize prompt with Gemini
async function optimizePrompt(rawPrompt: string, isCharacter: boolean, style?: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return rawPrompt;
  const ai = new GoogleGenAI({ apiKey });

  const selectedStyle = style || 'Cinematic, dramatic lighting, highly detailed';

  const systemPrompt = isCharacter
    ? `You are an expert prompt engineer for AI image generator. Translate the following Chinese character description into a concise, detailed, and high-quality English image prompt. Focus on facial features, hairstyle, expression, clothing details, and character archetype. Use professional descriptive words. Ensure it is optimized for high-quality portrait rendering. Style requested: ${selectedStyle}. Keep the response as pure English text prompt under 80 words, no explanations.`
    : `You are an expert prompt engineer for AI image generator. Translate the following Chinese video shot/storyboard description into a highly descriptive, cinematic English image prompt. Describe the camera angle, lighting, environment, subject action, composition, and emotional tone. Keep it optimized for film storyboard. Style requested: ${selectedStyle}. Keep the response as pure English text prompt under 100 words, no explanations.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        { text: systemPrompt },
        { text: `Chinese raw input: ${rawPrompt}` }
      ]
    });
    const resultText = response.text?.trim() || rawPrompt;
    console.log(`[Prompt Translator] Translated "${rawPrompt}" to "${resultText}"`);
    return resultText;
  } catch (err) {
    console.error('Prompt translation failed:', err);
    return rawPrompt;
  }
}


// Gemini Response JSON Schema
const responseSchema = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING', description: 'è§†é¢‘çš„æ ‡é¢˜/åç§°' },
    genre: { type: 'STRING', description: 'è§†é¢‘çš„ç±»åž‹/æµæ´¾ï¼Œä¾‹å¦‚ï¼šå‰§æƒ…ã€ç§‘å¹»ã€æ‚¬ç–‘ã€çºªå½•ç‰‡ã€å¹¿å‘Šç­‰' },
    tags: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'è§†é¢‘çš„æ ‡ç­¾ï¼Œä¾‹å¦‚ï¼šç´§å¼ ã€å”¯ç¾Žã€å¿«èŠ‚å¥ã€æ„Ÿäººç­‰'
    },
    shots: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          timestamp: { type: 'STRING', description: 'é•œå¤´çš„æ—¶é—´æˆ³èŒƒå›´ï¼Œä¾‹å¦‚ 00:00 - 00:05' },
          timeSeconds: { type: 'INTEGER', description: 'è¯¥é•œå¤´åœ¨è§†é¢‘ä¸­å¼€å§‹çš„ç§’æ•°' },
          movement: { type: 'STRING', description: 'è¿é•œæ–¹å¼ï¼Œä¾‹å¦‚ï¼šå›ºå®šé•œå¤´ã€å…¨æ™¯è·Ÿæ‹ã€ä½Žè§’åº¦æ‰‹æŒç­‰' },
          composition: { type: 'STRING', description: 'ç”»é¢æž„å›¾ï¼Œä¾‹å¦‚ï¼šä¸‰åˆ†æ³•ã€ä¸­å¿ƒæž„å›¾ã€æ¡†æž¶æž„å›¾ç­‰' },
          emotion: { type: 'STRING', description: 'é•œå¤´ä¼ è¾¾çš„æƒ…ç»ªï¼Œä¾‹å¦‚ï¼šéœ‡æ’¼ã€å¹³é™ã€ç¥žç§˜ã€æ»‘ç¨½ç­‰' },
          description: { type: 'STRING', description: 'è¯¥é•œå¤´ç”»é¢çš„å…·ä½“å†…å®¹å’Œæƒ…èŠ‚æè¿°' }
        },
        required: ['timestamp', 'timeSeconds', 'movement', 'composition', 'emotion', 'description']
      }
    },
    characters: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: 'è§’è‰²å§“åæˆ–ä»£å·/å¤–è§‚ç‰¹å¾ä»£ç§°ï¼Œä¾‹å¦‚ï¼šé»‘å‘å°‘å¥³ã€æ•™æŽˆã€é«˜å¤§å®ˆå«' },
          role: { type: 'STRING', description: 'è§’è‰²æˆä»½æˆ–å®šä½ï¼Œä¾‹å¦‚ï¼šä¸»è§’ã€åé¢äººç‰©ã€èƒŒæ™¯è·¯äºº' },
          personality: { type: 'STRING', description: 'è§’è‰²æ€§æ ¼ç‰¹ç‚¹æè¿°' },
          clothing: { type: 'STRING', description: 'è§’è‰²çš„æœè£…ã€æœé¥°åŠå¤–è²Œç‰¹å¾' }
        },
        required: ['name', 'role', 'personality', 'clothing']
      }
    },
    narrative: {
      type: 'OBJECT',
      properties: {
        structure: { type: 'STRING', description: 'æ•…äº‹çš„ä¸‰å¹•å‰§ç»“æž„åˆ†æžï¼ˆå¦‚å¼€ç«¯ã€é«˜æ½®ã€ç»“å±€ï¼‰' },
        rhythm: { type: 'STRING', description: 'è§†é¢‘æ•´ä½“çš„å‰ªè¾‘èŠ‚å¥ã€è§†å¬æ­é…ä¸ŽèŠ‚å¥èµ·ä¼ç‰¹ç‚¹' },
        climaxDesign: { type: 'STRING', description: 'åˆ†æžæ•…äº‹çš„çˆ½ç‚¹ä½ç½®ã€æˆå‰§å†²çªé«˜æ½®ç‚¹ä»¥åŠæ˜¯å¦‚ä½•è®¾è®¡çš„' }
      },
      required: ['structure', 'rhythm', 'climaxDesign']
    }
  },
  required: ['title', 'genre', 'tags', 'shots', 'characters', 'narrative']
};

// API Endpoints

// 1. GET /api/videos - Query videos with filters
app.get('/api/videos', (req, res) => {
  try {
    const db = readDb();
    const { q, genre, tag } = req.query;

    let filtered = [...db.videos];

    if (q) {
      const query = (q as string).toLowerCase();
      filtered = filtered.filter(v =>
        v.title.toLowerCase().includes(query) ||
        (v.genre && v.genre.toLowerCase().includes(query)) ||
        (v.tags && v.tags.some((t: string) => t.toLowerCase().includes(query)))
      );
    }

    if (genre && genre !== 'all') {
      const gen = (genre as string).toLowerCase();
      filtered = filtered.filter(v => v.genre && v.genre.toLowerCase() === gen);
    }

    if (tag && tag !== 'all') {
      const t = (tag as string).toLowerCase();
      filtered = filtered.filter(v => v.tags && v.tags.some((x: string) => x.toLowerCase() === t));
    }

    // Sort by createdAt descending
    filtered.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    res.json(filtered);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve videos' });
  }
});

// 2. GET /api/genres-tags - Get unique genres and tags in DB
app.get('/api/genres-tags', (req, res) => {
  try {
    const db = readDb();
    const genres = new Set<string>();
    const tags = new Set<string>();

    db.videos.forEach((v: any) => {
      if (v.genre) genres.add(v.genre);
      if (Array.isArray(v.tags)) {
        v.tags.forEach((t: string) => tags.add(t));
      }
    });

    res.json({
      genres: Array.from(genres),
      tags: Array.from(tags)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve categories and tags' });
  }
});

// 3. GET /api/videos/:id - Retrieve specific video
app.get('/api/videos/:id', (req, res) => {
  try {
    const db = readDb();
    const video = db.videos.find((v: any) => v.id === req.params.id);
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    res.json(video);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve video details' });
  }
});

// 4. POST /api/upload - Receive uploaded file locally
app.post('/api/upload', upload.single('video'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    res.json({
      filename: req.file.filename,
      originalname: req.file.originalname,
      filepath: req.file.path,
      url: `/uploads/${req.file.filename}`,
      size: req.file.size
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Video upload failed' });
  }
});

// 5. POST /api/analyze - Upload video to Gemini, run analysis, store JSON and details
app.post('/api/analyze', async (req, res) => {
  const { filename, filepath, title, shortDramaMode } = req.body;

  if (!filename || !filepath) {
    return res.status(400).json({ error: 'filename and filepath are required' });
  }

  const fullFilePath = path.isAbsolute(filepath) ? filepath : path.join(__dirname, filepath);
  if (!fs.existsSync(fullFilePath)) {
    return res.status(404).json({ error: `File not found at: ${fullFilePath}` });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GEMINI_API_KEY environment variable is not configured.' });
    }

    const ai = new GoogleGenAI({ apiKey });

    // Determine mimeType
    const ext = path.extname(filename).toLowerCase();
    let mimeType = 'video/mp4';
    if (ext === '.webm') mimeType = 'video/webm';
    else if (ext === '.mov') mimeType = 'video/quicktime';
    else if (ext === '.avi') mimeType = 'video/x-msvideo';

    console.log(`[Gemini] Uploading file to Gemini storage: ${filename}...`);

    // Upload local file to Gemini Files API
    let fileInfo = await ai.files.upload({
      file: fullFilePath,
      config: {
        mimeType: mimeType,
      }
    });

    console.log(`[Gemini] File uploaded, URI: ${fileInfo.uri}. State: ${fileInfo.state}`);

    // Poll Gemini storage state until ACTIVE
    while (fileInfo.state === 'PROCESSING') {
      console.log('[Gemini] File is processing, waiting 5 seconds...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      fileInfo = await ai.files.get({ name: fileInfo.name });
    }

    if (fileInfo.state === 'FAILED') {
      throw new Error('Gemini API video processing failed.');
    }
    console.log('[Gemini] File is active on Gemini. Starting analysis...');

    let prompt = `ä½ æ˜¯ä¸€ä¸ªä¸“ä¸šçš„å½±è§†åˆ†æžå¤§å¸ˆã€‚è¯·ä»”ç»†è§‚çœ‹è¿™æ®µè§†é¢‘ï¼Œå¹¶è¾“å‡ºä¸€ä¸ªè¯¦ç»†çš„ä¸­æ–‡è§†é¢‘ç»“æž„åŒ–åˆ†æžæŠ¥å‘Šã€‚
è¯·ä¸¥æ ¼æŒ‰ç…§æä¾›çš„ JSON Schema è¾“å‡ºï¼Œå¿…é¡»åŒ…å«ä»¥ä¸‹å†…å®¹ï¼š
1. é•œå¤´åˆ—è¡¨ (shots)ï¼šè¯·ä»¥æ¯ä¸ªâ€œç‰©ç†å‰ªè¾‘ç‚¹ (Cut Point / Edit Point)â€ä¸ºå•ä½è¯†åˆ«åˆ†é•œï¼Œæœ€å°åˆ†æžç²’åº¦ä¸º1ç§’ã€‚ç»å¯¹ä¸è¦åˆå¹¶å†…å®¹ç›¸ä¼¼æˆ–è¿žç»­å‘ç”Ÿçš„ç›¸é‚»é•œå¤´ã€‚æ¯ä¸€æ¬¡ç”»é¢åˆ‡æ¢/ç‰©ç†å‰ªè¾‘å‘ç”ŸåŽï¼Œå¿…é¡»å•ç‹¬è¾“å‡ºä¸€æ¡é•œå¤´è®°å½•ã€‚æ¯ä¸ªé•œå¤´éœ€è¦åŒ…å«æ—¶é—´èŒƒå›´ï¼ˆå¦‚ 00:00 - 00:05ï¼Œèµ·æ­¢æ—¶é—´è¦ç²¾å‡†å¯¹é½ç‰©ç†å‰ªè¾‘ç‚¹ï¼‰ã€è¯¥é•œå¤´åœ¨è§†é¢‘ä¸­å¼€å§‹çš„ç§’æ•° (timeSeconds, æ•´æ•°ï¼Œè¡¨ç¤ºè·è§†é¢‘å¼€å¤´çš„ç§’æ•°)ã€è¿é•œæ–¹å¼ã€ç”»é¢æž„å›¾ã€æƒ…ç»ªåŸºè°ƒä»¥åŠå…·ä½“çš„ç”»é¢å†…å®¹æƒ…èŠ‚æè¿°ã€‚
2. äººç‰©ç”»åƒ (characters)ï¼šå¦‚æžœè§†é¢‘ä¸­å‡ºçŽ°ä¸»è¦äººç‰©ï¼Œè¯·æå–æ‰€æœ‰ä¸»è¦è§’è‰²çš„å§“åæˆ–å¤–è§‚ä»£ç§°ã€è§’è‰²èº«ä»½å®šä½ã€æ€§æ ¼ç‰¹å¾ã€æœè£…æè¿°ã€‚è‹¥æ— è§’è‰²æˆ–äººç‰©ï¼Œå¯ä¸ºç©ºåˆ—è¡¨ã€‚
3. å™äº‹ä¸Žçˆ½ç‚¹ (narrative)ï¼šæ·±å…¥åˆ†æžæ•…äº‹çš„æ•…äº‹ç»“æž„ï¼ˆå¦‚ä¸‰å¹•å‰§ç»“æž„ï¼‰ã€å‰ªè¾‘ä¸Žè§†å¬èŠ‚å¥ç‰¹ç‚¹ã€çˆ½ç‚¹è®¾è®¡ä¸Žå†²çªçˆ†ç‚¹ä½ç½®ã€‚

è¯·ç¡®ä¿åˆ†æžç»†è‡´å…¥å¾®ã€æ¡ç†æ¸…æ™°ï¼Œä¸¥æ ¼éµå®ˆç‰©ç†å‰ªè¾‘åˆ†é•œåˆ’åˆ†è§„åˆ™ã€‚`;

    if (shortDramaMode) {
      prompt += `\nç‰¹åˆ«æ³¨æ„ï¼šè¿™æ˜¯ç«–å±çŸ­å‰§ï¼Œæ¯3-5ç§’ä¸€ä¸ªé•œå¤´ï¼ŒæŒ‰å°è¯åœé¡¿å’Œæƒ…ç»ªè½¬æŠ˜åˆ‡åˆ†ã€‚`;
      console.log('[Gemini] Short Drama Mode enabled for video analysis prompt.');
    }

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          fileData: {
            fileUri: fileInfo.uri,
            mimeType: fileInfo.mimeType
          }
        },
        prompt
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: responseSchema
      }
    });

    console.log('[Gemini] Analysis response received successfully.');

    // Parse response text
    let analysisResult;
    try {
      analysisResult = JSON.parse(response.text);
    } catch (e) {
      console.error('Failed to parse Gemini JSON response:', response.text);
      throw new Error('Gemini did not return valid JSON conformant to the schema.');
    }

    // Clean up Gemini storage
    try {
      await ai.files.delete({ name: fileInfo.name });
      console.log('[Gemini] Cleaned up file from Gemini files API storage.');
    } catch (err) {
      console.warn('[Gemini] Failed to clean up file from Gemini storage:', err);
    }

    // Store in DB
    const videoRecord = {
      id: Date.now().toString(),
      filename: filename,
      filepath: filepath,
      url: `/uploads/${filename}`,
      title: title || analysisResult.title || filename,
      genre: analysisResult.genre || 'å‰§æƒ…',
      tags: analysisResult.tags || [],
      analysis: {
        shots: analysisResult.shots || [],
        characters: analysisResult.characters || [],
        narrative: analysisResult.narrative || {}
      },
      createdAt: new Date().toISOString()
    };

    await mutateDb((db) => {
      db.videos.push(videoRecord);
    });
    console.log(`[DB] Successfully stored record for video: ${videoRecord.title}`);

    res.json(videoRecord);
  } catch (err: any) {
    console.error('[Analyze Error]', err);
    res.status(500).json({ error: err.message || 'Video analysis failed.' });
  }
});

// 6. DELETE /api/videos/:id - Delete video record and local file
app.delete('/api/videos/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let video: any = null;
    let found = false;

    await mutateDb((db) => {
      const index = db.videos.findIndex((v: any) => v.id === id);
      if (index !== -1) {
        video = db.videos[index];
        db.videos.splice(index, 1);
        found = true;
      }
    });

    if (!found) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // Delete local video file if exists
    const localPath = path.join(__dirname, 'uploads', video.filename);
    if (fs.existsSync(localPath)) {
      try {
        fs.unlinkSync(localPath);
        console.log(`Deleted local file: ${localPath}`);
      } catch (err) {
        console.error(`Failed to delete local file: ${localPath}`, err);
      }
    }

    res.json({ success: true, message: 'Video deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete video' });
  }
});

// 7. POST /api/generate-script - Generate new script from template
app.post('/api/generate-script', async (req, res) => {
  const { templateId, topic, preferences, shortDramaMode } = req.body;
  const requestedShotCount = Math.max(0, Math.min(30, Number(preferences?.shotCount) || 0));
  const requestedCharacterCount = Math.max(0, Math.min(10, Number(preferences?.characterCount) || 0));

  if (!topic) {
    return res.status(400).json({ error: 'æ–°æ•…äº‹ä¸»é¢˜/è®¾å®šæ˜¯å¿…éœ€çš„ã€‚' });
  }

  try {
    let templateData = DEMO_TEMPLATE;
    const db = readDb();

    if (templateId && templateId !== 'demo') {
      const video = db.videos.find((v: any) => v.id === templateId);
      if (video && video.analysis) {
        templateData = video.analysis;
      }
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GEMINI_API_KEY environment variable is not configured.' });
    }

    const ai = new GoogleGenAI({ apiKey });

    let prompt = `ä½ æ˜¯ä¸€ä¸ªä¸šç•Œé¡¶çº§çš„å½±è§†é‡‘ç‰Œç¼–å‰§å’Œåˆ†é•œå¯¼æ¼”ã€‚
çŽ°åœ¨ï¼Œæˆ‘ä»¬è¦ä»¥ä¸€ä¸ªçŽ°æœ‰çš„è§†é¢‘åˆ†æžæ•°æ®ä½œä¸ºâ€œåˆ›æ„éª¨æž¶ä¸ŽèŠ‚å¥æ¨¡æ¿â€ï¼Œä¸ºä½ æŒ‡å®šçš„ä¸€ä¸ªæ–°æ•…äº‹è®¾å®šåˆ›ä½œä¸€å¥—å…¨æ–°ä¸”é«˜è´¨é‡çš„å½±è§†å‰§æœ¬ã€è§’è‰²å¡ç‰‡å’Œåˆ†é•œè„šæœ¬ã€‚

ã€æ–°æ•…äº‹è®¾å®š/ä¸»é¢˜ã€‘
${topic}

ã€æ¨¡æ¿è§†é¢‘æ•°æ®ã€‘
1. å™äº‹èŠ‚å¥ä¸Žçˆ½ç‚¹ï¼š
   - ä¸‰å¹•ç»“æž„ï¼š${templateData.narrative.structure}
   - è§†å¬èŠ‚å¥ï¼š${templateData.narrative.rhythm}
   - çˆ½ç‚¹å†²çªè®¾è®¡ï¼š${templateData.narrative.climaxDesign || (templateData.narrative as any).climaxDesign}
2. æ¨¡æ¿äººç‰©å…³ç³»ä¸Žå®šä½ï¼š
   ${JSON.stringify(templateData.characters, null, 2)}
3. æ¨¡æ¿åˆ†é•œåºåˆ—ä¸Žè¿é•œç¾Žå­¦ï¼š
   ${JSON.stringify(templateData.shots.map(s => ({
     timestamp: s.timestamp,
     timeSeconds: s.timeSeconds,
     movement: s.movement,
     composition: s.composition,
     emotion: s.emotion,
     description: s.description
   })), null, 2)}

ã€åˆ›ä½œè¦æ±‚ã€‘
1. **ç»“æž„ä¸Žè¿é•œç»§æ‰¿**ï¼šæ–°å‰§æœ¬çš„åˆ†é•œèŠ‚å¥ã€è½¬æŠ˜èµ·ä¼å’Œå™äº‹é˜¶æ®µå¿…é¡»ä¸¥æ ¼å¯¹åº”æ¨¡æ¿è§†é¢‘çš„åˆ†é•œè„‰ç»œï¼ä¾‹å¦‚ï¼šå¦‚æžœæ¨¡æ¿è§†é¢‘åœ¨ç¬¬1ä¸ªåˆ†é•œæ˜¯â€œèˆªæ‹å±•çŽ°å®å¤§ä¸–ç•Œè§‚â€ï¼Œé‚£æ–°æ•…äº‹çš„ç¬¬1ä¸ªåˆ†é•œä¹Ÿåº”å½“æ˜¯ç”¨å®å¤§çš„è¿é•œ and ç”»é¢æž„å›¾å±•çŽ°ä½ çš„æ–°ä¸»é¢˜ä¸–ç•Œè§‚ï¼›å¦‚æžœæ¨¡æ¿åœ¨æŸå¤„å‘ç”Ÿäº†ç©ºé—´ç©¿æ¢­æˆ–ç‹¼ç‹ˆæ»‘å€’çš„æƒ…èŠ‚ï¼Œæ–°å‰§æœ¬ä¹Ÿåº”å½“åœ¨å¯¹åº”é•œå¤´è®¾è®¡å‡ºç›¸åŒå¼ åŠ›èŠ‚å¥çš„äº‹ä»¶ã€‚
2. **äººç‰©æ˜ å°„**ï¼šæ–°æ•…äº‹ä¸­çš„ä¸»è¦è§’è‰²å’Œäººç‰©å…³ç³»åº”å½“ä¸Žæ¨¡æ¿ä¸­çš„æ€§æ ¼ç‰¹å¾å½¢æˆé²œæ˜Žæ˜ å°„ï¼ˆå¦‚ï¼šä¸€ä¸ªå†·é¢é¢†èˆªè€…ã€ä¸€ä¸ªå‚²å¨‡å­¦è€…ã€ä¸€ä¸ªè±ªçˆ½ç³™æ±‰æˆ˜å£«ï¼‰ï¼Œä½†è§’è‰²çš„åç§°ã€æœé¥°è£…å¤‡ã€å°è¯ç»†èŠ‚å¿…é¡»å®Œå…¨åŽŸåˆ›å¹¶å¯¹é½æ–°çš„ä¸»é¢˜è®¾å®šã€‚
3. **å†…å®¹é«˜åº¦åŽŸåˆ›**ï¼šé•œå¤´çš„æƒ…èŠ‚è¯´æ˜Žã€å°è¯ã€æƒ…æ„Ÿå˜åŒ–å¿…é¡»ç”ŸåŠ¨æœ‰è¶£ã€ç¬¦åˆä½ èµ„æ·±ç¼–å‰§çš„èº«ä»½ã€‚ç¦æ­¢åŽŸæ ·ç…§æŠ„æ¨¡æ¿ä¸­ steampunk/é£žç©ºè‰‡/é›ªå±±ç­‰ç‰¹æœ‰è¯æ±‡ï¼Œå¿…é¡»å¯¹é½æ–°æ•…äº‹çš„ä¸»é¢˜è®¾å®šè¿›è¡Œæ·±åº¦åˆ›ä½œã€‚

è¯·ä¸¥æ ¼æŒ‰ç…§æä¾›çš„ JSON Schema è¾“å‡ºä¸­æ–‡åˆ†æžç»“æžœã€‚`;

    if (shortDramaMode) {
      prompt += `\n\nã€çŸ­å‰§æ¨¡å¼å¯ç”¨ã€‘\né‡è¦è¦æ±‚ï¼šè¿™æ˜¯ç«–å±çŸ­å‰§ï¼Œæ¯3-5ç§’ä¸€ä¸ªé•œå¤´ï¼ŒæŒ‰å°è¯åœé¡¿å’Œæƒ…ç»ªè½¬æŠ˜åˆ‡åˆ†ã€‚`;
      console.log('[Script Generator] Short Drama Mode enabled for script writing prompt.');
    }

    if (requestedShotCount) {
      prompt += `\n\nMANDATORY OUTPUT CONSTRAINT: Return exactly ${requestedShotCount} storyboard shots in newShots. Do not return more or fewer shots.`;
    }
    if (requestedCharacterCount) {
      prompt += `\nMANDATORY OUTPUT CONSTRAINT: Return exactly ${requestedCharacterCount} principal character(s) in newCharacters and keep the same character identity consistent across every shot.`;
    }

    const generatedScriptSchema = {
      type: 'OBJECT',
      properties: {
        newTitle: { type: 'STRING', description: 'å…¨æ–°å‰§æœ¬çš„æ ‡é¢˜' },
        newNarrative: {
          type: 'OBJECT',
          properties: {
            structure: { type: 'STRING', description: 'æ–°å‰§æœ¬çš„ä¸‰å¹•å™äº‹ç»“æž„è®¾è®¡ï¼ˆå¯¹ç…§æ¨¡æ¿ç»“æž„çš„èµ·æ‰¿è½¬åˆï¼‰' },
            rhythm: { type: 'STRING', description: 'æ–°å‰§æœ¬çš„æƒ…èŠ‚ä¸ŽåŠ¨ä½œèŠ‚å¥è§„åˆ’ï¼ˆå¯¹ç…§æ¨¡æ¿çš„èŠ‚å¥ç‰¹ç‚¹ï¼‰' },
            climaxDesign: { type: 'STRING', description: 'æ–°å‰§æœ¬çš„å†²çªçˆ½ç‚¹ä½ç½®ä¸Žçˆ†å‘è®¾è®¡è¯´æ˜Ž' }
          },
          required: ['structure', 'rhythm', 'climaxDesign']
        },
        newCharacters: {
          type: 'ARRAY',
          ...(requestedCharacterCount ? { minItems: requestedCharacterCount, maxItems: requestedCharacterCount } : {}),
          items: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING', description: 'æ–°æ•…äº‹ä¸­çš„è§’è‰²å§“åæˆ–ä»£ç§°' },
              role: { type: 'STRING', description: 'æ–°è§’è‰²å®šä½ï¼ˆå¯¹åº”æ¨¡æ¿ä¸­æŸä¸ªäººç‰©çš„è§’è‰²å®šä½ä¸Žå†²çªå…³ç³»ï¼‰' },
              personality: { type: 'STRING', description: 'æ–°è§’è‰²çš„æ€§æ ¼ç‰¹å¾' },
              clothing: { type: 'STRING', description: 'æ–°è§’è‰²çš„æœè£…/æœé¥°/å¤–è²Œè®¾å®šæè¿°' }
            },
            required: ['name', 'role', 'personality', 'clothing']
          }
        },
        newShots: {
          type: 'ARRAY',
          ...(requestedShotCount ? { minItems: requestedShotCount, maxItems: requestedShotCount } : {}),
          items: {
            type: 'OBJECT',
            properties: {
              timestamp: { type: 'STRING', description: 'é•œå¤´çš„æ¨¡æ‹Ÿæ—¶é—´æˆ³ï¼Œå¦‚ 00:00 - 00:05' },
              timeSeconds: { type: 'INTEGER', description: 'é•œå¤´çš„å¼€å§‹ç§’æ•°ï¼ˆæ•´æ•°ï¼‰' },
              movement: { type: 'STRING', description: 'è¯¥é•œå¤´çš„è¿é•œæ–¹å¼ï¼Œå¦‚å…¨æ™¯è·Ÿæ‹ã€æŽ¨è½¨ç‰¹å†™ç­‰ï¼ˆéœ€ç»§æ‰¿æ¨¡æ¿çš„é•œå¤´è¯­è¨€ï¼‰' },
              composition: { type: 'STRING', description: 'è¯¥é•œå¤´çš„ç”»é¢æž„å›¾æ–¹å¼ï¼Œå¦‚ä¸‰åˆ†æ³•ã€æ¡†å¼æž„å›¾ç­‰ï¼ˆéœ€ç»§æ‰¿æ¨¡æ¿çš„æž„å›¾ç¾Žå­¦ï¼‰' },
              emotion: { type: 'STRING', description: 'è¯¥é•œå¤´ä¼ è¾¾çš„æƒ…ç»ªï¼Œå¦‚éœ‡æ’¼ã€ç¥žç§˜ã€ç´§å¼ ç­‰' },
              description: { type: 'STRING', description: 'é•œå¤´ä¸‹çš„å…·ä½“æƒ…èŠ‚åŠ¨ä½œæè¿°ã€äººç‰©å¯¹è¯ä»¥åŠéŸ³æ•ˆè§„åˆ’' }
            },
            required: ['timestamp', 'timeSeconds', 'movement', 'composition', 'emotion', 'description']
          }
        }
      },
      required: ['newTitle', 'newNarrative', 'newCharacters', 'newShots']
    };

    console.log(`[Script Generator] Running Gemini scriptwriter for topic: ${topic}...`);

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: generatedScriptSchema
      }
    });

    console.log('[Script Generator] Generated successfully.');

    let result;
    try {
      result = JSON.parse(response.text);
    } catch (e) {
      console.error('Failed to parse Gemini script JSON response:', response.text);
      throw new Error('Gemini did not return valid JSON conformant to script schema.');
    }

    // Create database record
    const generatedCharacters = result.newCharacters.map((c: any) => ({
      id: crypto.randomUUID(),
      ...c,
      avatarUrl: ''
    }));
    const generatedShots = result.newShots.map((s: any) => ({
      id: crypto.randomUUID(),
      ...s,
      matchedCharacterIds: inferMatchedCharacterIds(s.description, generatedCharacters),
      imageUrl: ''
    }));
    const scriptRecord = {
      id: Date.now().toString(),
      templateId: templateId || 'demo',
      templateTitle: templateId === 'demo' ? 'æ¼”ç¤ºåˆ†é•œæ¨¡æ¿' : (db.videos.find((v: any) => v.id === templateId)?.title || 'æœªçŸ¥æ¨¡æ¿'),
      topic: topic,
      createdAt: new Date().toISOString(),
      comfyuiPreferences: readDefaultComfyPreferences(),
      newTitle: result.newTitle,
      newNarrative: result.newNarrative,
      newCharacters: generatedCharacters,
      newShots: generatedShots
    };

    await mutateDb((db) => {
      db.generated_scripts.push(scriptRecord);
    });
    console.log(`[DB] Successfully stored generated script: ${scriptRecord.newTitle}`);

    res.json(scriptRecord);
  } catch (err: any) {
    console.error('[Script Generator Error]', err);
    res.status(500).json({ error: err.message || 'Failed to generate creative script.' });
  }
});


// 8. GET /api/generated-scripts - Get all history generated scripts
app.get('/api/generated-scripts', (req, res) => {
  try {
    const db = readDb();
    const list = [...db.generated_scripts]
      .map((script: any) => ({
        ...script,
        newShots: (script.newShots || []).map((shot: any) => ({
          ...shot,
          matchedCharacterIds: Array.isArray(shot.matchedCharacterIds)
            ? shot.matchedCharacterIds
            : inferMatchedCharacterIds(shot.description, script.newCharacters || []),
        })),
      }))
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve generated scripts' });
  }
});

type ComfyProjectPreferences = {
  shotPresetId: string;
  characterMasterPresetId: string;
  identityPresetId: string;
  threeViewPresetId: string;
  upscalePresetId: string;
};

const LEGACY_PROJECT_COMFY_PREFERENCES: ComfyProjectPreferences = {
  shotPresetId: 'sdxl_legacy',
  characterMasterPresetId: 'sdxl_legacy',
  identityPresetId: 'pulid_flux2',
  threeViewPresetId: 'legacy_three_views',
  upscalePresetId: 'esrgan_4x',
};

const RECOMMENDED_PROJECT_COMFY_PREFERENCES: ComfyProjectPreferences = {
  shotPresetId: 'pure_klein',
  characterMasterPresetId: 'pure_klein',
  identityPresetId: 'pulid_flux2',
  threeViewPresetId: 'qwen_2511_three_views',
  upscalePresetId: 'esrgan_4x',
};

const PROJECT_PRESET_TO_WORKFLOW: Record<string, string | null> = {
  sdxl_legacy: null,
  pure_klein: '01_klein_character_master',
  pulid_flux2: '02_klein_pulid_identity',
  qwen_2511_three_views: '03_qwen_2511_three_views',
  esrgan_4x: '04_esrgan_upscale',
  legacy_three_views: null,
  '01_klein_character_master': '01_klein_character_master',
  '02_klein_pulid_identity': '02_klein_pulid_identity',
  '03_qwen_2511_three_views': '03_qwen_2511_three_views',
  '04_esrgan_upscale': '04_esrgan_upscale',
};

type PresetPurpose = 'storyboard' | 'characterMaster' | 'identity' | 'threeView' | 'upscale';

const BUILTIN_PRESET_METADATA: Record<string, { displayName: string; workflowFamily: string; purposes: PresetPurpose[]; modelName?: string }> = {
  sdxl_legacy: { displayName: 'SDXL Legacy', workflowFamily: 'sdxl', purposes: ['storyboard', 'characterMaster'], modelName: process.env.COMFYUI_CKPT_NAME || 'ComfyUI 默认 SDXL Checkpoint' },
  legacy_three_views: { displayName: '现有三视图流程', workflowFamily: 'legacy', purposes: ['threeView'], modelName: 'Legacy image workflow' },
  '01_klein_character_master': { displayName: 'Pure Klein 4B', workflowFamily: 'flux/klein', purposes: ['storyboard', 'characterMaster'] },
  '02_klein_pulid_identity': { displayName: 'PuLID Flux2', workflowFamily: 'flux/pulid', purposes: ['identity'] },
  '03_qwen_2511_three_views': { displayName: 'Qwen 三视图', workflowFamily: 'qwen', purposes: ['threeView'] },
  '04_esrgan_upscale': { displayName: 'ESRGAN 4x', workflowFamily: 'upscale', purposes: ['upscale'] },
};

const LOCAL_PRESET_DIR = path.resolve('workflows/local');

function resolvePresetManifestPath(presetId: string): string | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(presetId)) return null;
  for (const directory of [path.resolve('workflows/character'), LOCAL_PRESET_DIR]) {
    const candidate = path.join(directory, `${presetId}.manifest.json`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function workflowIdForSelection(selectedPreset: string): string | null | undefined {
  if (selectedPreset in PROJECT_PRESET_TO_WORKFLOW) return PROJECT_PRESET_TO_WORKFLOW[selectedPreset];
  return resolvePresetManifestPath(selectedPreset) ? selectedPreset : undefined;
}

function presetPurposes(presetId: string): PresetPurpose[] {
  const builtin = BUILTIN_PRESET_METADATA[presetId];
  if (builtin) return builtin.purposes;
  const manifestPath = resolvePresetManifestPath(presetId);
  if (!manifestPath) return [];
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return Array.isArray(manifest.purposes)
      ? manifest.purposes.filter((purpose: string) => ['storyboard', 'characterMaster', 'identity', 'threeView', 'upscale'].includes(purpose))
      : [];
  } catch {
    return [];
  }
}

function readDefaultComfyPreferences(): ComfyProjectPreferences {
  const row = dbSqlite.prepare("SELECT value FROM store WHERE key = 'comfyui_default_preferences'").get() as { value: string } | undefined;
  if (!row) return { ...LEGACY_PROJECT_COMFY_PREFERENCES };
  try {
    return { ...LEGACY_PROJECT_COMFY_PREFERENCES, ...JSON.parse(row.value) };
  } catch {
    return { ...LEGACY_PROJECT_COMFY_PREFERENCES };
  }
}

function projectComfyPreferences(projectId: string): ComfyProjectPreferences {
  const script = readDb().generated_scripts.find((item: any) => String(item.id) === String(projectId));
  const saved = script?.comfyuiPreferences;
  return {
    ...LEGACY_PROJECT_COMFY_PREFERENCES,
    ...(saved && typeof saved === 'object' ? saved : {}),
  };
}

function normalizeComfyPreferences(requested: any): ComfyProjectPreferences {
  return {
    shotPresetId: String(requested?.shotPresetId || ''),
    characterMasterPresetId: String(requested?.characterMasterPresetId || ''),
    identityPresetId: String(requested?.identityPresetId || ''),
    threeViewPresetId: String(requested?.threeViewPresetId || ''),
    upscalePresetId: String(requested?.upscalePresetId || ''),
  };
}

function validateComfyPreferences(preferences: ComfyProjectPreferences): string | null {
  const requiredPurpose: Record<keyof ComfyProjectPreferences, PresetPurpose> = {
    shotPresetId: 'storyboard',
    characterMasterPresetId: 'characterMaster',
    identityPresetId: 'identity',
    threeViewPresetId: 'threeView',
    upscalePresetId: 'upscale',
  };
  for (const key of Object.keys(requiredPurpose) as Array<keyof ComfyProjectPreferences>) {
    const value = preferences[key];
    const workflowId = workflowIdForSelection(value);
    const normalizedId = workflowId === null ? value : workflowId;
    if (workflowId === undefined || !presetPurposes(normalizedId || value).includes(requiredPurpose[key])) {
      return `Unsupported ${key}: ${value}`;
    }
  }
  return null;
}

app.get('/api/comfyui/default-preferences', (_req, res) => {
  res.json({ preferences: readDefaultComfyPreferences() });
});

app.put('/api/comfyui/default-preferences', (req, res) => {
  const preferences = normalizeComfyPreferences(req.body?.preferences);
  const validationError = validateComfyPreferences(preferences);
  if (validationError) return res.status(422).json({ error: validationError });
  dbSqlite.prepare("INSERT OR REPLACE INTO store (key, value) VALUES ('comfyui_default_preferences', ?)").run(JSON.stringify(preferences));
  return res.json({ success: true, preferences });
});

function qwenThreeViewsVerified(projectId: string): boolean {
  return !!dbSqlite.prepare(`
    SELECT workflowBatchId FROM comfyui_tasks
    WHERE projectId = ? AND workflowPresetId = '03_qwen_2511_three_views'
      AND status = 'succeeded' AND viewType IN ('front', 'side', 'back')
      AND workflowBatchId IS NOT NULL
    GROUP BY workflowBatchId, targetId
    HAVING COUNT(DISTINCT viewType) = 3
    LIMIT 1
  `).get(projectId);
}

app.get('/api/generated-scripts/:id/comfyui-preferences', (req, res) => {
  const projectId = req.params.id;
  const script = readDb().generated_scripts.find((item: any) => String(item.id) === String(projectId));
  if (!script) return res.status(404).json({ error: 'Script not found' });
  return res.json({
    preferences: projectComfyPreferences(projectId),
    qwenThreeViewVerified: qwenThreeViewsVerified(projectId),
    hasSavedPreferences: !!script.comfyuiPreferences,
  });
});

app.put('/api/generated-scripts/:id/comfyui-preferences', async (req, res) => {
  const projectId = req.params.id;
  const requested = req.body?.recommended === true
    ? RECOMMENDED_PROJECT_COMFY_PREFERENCES
    : req.body?.preferences;
  if (!requested || typeof requested !== 'object') {
    return res.status(400).json({ error: 'preferences are required' });
  }

  const preferences = normalizeComfyPreferences(requested);
  const validationError = validateComfyPreferences(preferences);
  if (validationError) return res.status(422).json({ error: validationError });
  const qwenVerified = qwenThreeViewsVerified(projectId);

  let updatedScript: any = null;
  await mutateDb(db => {
    const index = db.generated_scripts.findIndex((item: any) => String(item.id) === String(projectId));
    if (index < 0) return;
    db.generated_scripts[index] = { ...db.generated_scripts[index], comfyuiPreferences: preferences };
    updatedScript = db.generated_scripts[index];
  });
  if (!updatedScript) return res.status(404).json({ error: 'Script not found' });
  return res.json({ success: true, preferences, qwenThreeViewVerified: qwenVerified, updatedScript });
});

// 9. DELETE /api/generated-scripts/:id - Delete specific script record
app.delete('/api/generated-scripts/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let found = false;
    await mutateDb((db) => {
      const index = db.generated_scripts.findIndex((s: any) => String(s.id) === String(id));
      if (index !== -1) {
        db.generated_scripts.splice(index, 1);
        found = true;
      }
    });
    if (!found) {
      return res.status(404).json({ error: 'Script not found' });
    }
    res.json({ success: true, message: 'Script deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete script' });
  }
});

// 9.5. PUT /api/generated-scripts/:id - Update script record (e.g. shots, titles)
function characterMatchTerms(character: any): string[] {
  const aliases = Array.isArray(character?.aliases)
    ? character.aliases
    : Array.isArray(character?.alias)
      ? character.alias
      : character?.alias
        ? [character.alias]
        : [];
  const name = String(character?.name || '').trim();
  const bilingualNameParts = name
    ? [name.replace(/\s*[（(][^）)]*[）)]\s*$/, ''), ...(name.match(/[（(]([^）)]+)[）)]/)?.slice(1) || [])]
    : [];
  return [name, ...bilingualNameParts, ...aliases]
    .map(value => String(value || '').trim().toLocaleLowerCase())
    .filter(Boolean);
}

function inferMatchedCharacterIds(description: unknown, characters: any[]): string[] {
  const searchable = String(description || '').toLocaleLowerCase();
  if (!searchable) return [];
  return characters
    .filter(character => character?.id && characterMatchTerms(character).some(term => searchable.includes(term)))
    .map(character => String(character.id));
}

app.put('/api/generated-scripts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { newShots, newCharacters, title, summary, tone, pace } = req.body;

    let found = false;
    let updatedScript: any = null;
    await mutateDb((db) => {
      const index = db.generated_scripts.findIndex((s: any) => s.id === id);
      if (index !== -1) {
        const script = db.generated_scripts[index];
        if (newShots) script.newShots = newShots;
        if (newCharacters) script.newCharacters = newCharacters;
        if (title) script.title = title;
        if (summary) script.summary = summary;
        if (tone) script.tone = tone;
        if (pace) script.pace = pace;

        db.generated_scripts[index] = script;
        updatedScript = script;
        found = true;
      }
    });

    if (!found) {
      return res.status(404).json({ error: 'Script not found' });
    }

    res.json({ success: true, script: updatedScript });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update script: ' + err.message });
  }
});

app.put('/api/generated-scripts/:id/shots/:shotId/matched-characters', async (req, res) => {
  const projectId = String(req.params.id);
  const shotId = String(req.params.shotId);
  const requestedIds = req.body?.matchedCharacterIds;
  const requestUrl = req.originalUrl;
  const respond = (status: number, payload: any) => {
    console.log('[RoleBindingSave]', JSON.stringify({ url: requestUrl, method: req.method, body: req.body, projectId, shotId, status }));
    return res.status(status).json(payload);
  };
  if (!Array.isArray(requestedIds)) {
    return respond(400, { error: 'matchedCharacterIds must be an array', projectId, shotId });
  }
  const matchedCharacterIds = [...new Set(requestedIds.map(value => String(value).trim()).filter(Boolean))];
  let projectFound = false;
  let shotFound = false;
  let invalidCharacterIds: string[] = [];
  let updatedShot: any = null;
  try {
    await mutateDb((db) => {
      const script = db.generated_scripts.find((item: any) => String(item.id) === projectId);
      if (!script) return;
      projectFound = true;
      const shot = (script.newShots || []).find((item: any) => String(item.id) === shotId);
      if (!shot) return;
      shotFound = true;
      const validCharacterIds = new Set((script.newCharacters || []).map((character: any) => String(character.id || '')).filter(Boolean));
      invalidCharacterIds = matchedCharacterIds.filter(characterId => !validCharacterIds.has(characterId));
      if (invalidCharacterIds.length) return;
      shot.matchedCharacterIds = matchedCharacterIds;
      updatedShot = { ...shot };
    });
    if (!projectFound) return respond(404, { error: 'Project not found', projectId, shotId, matchedCharacterIds });
    if (!shotFound) return respond(404, { error: 'Shot not found', projectId, shotId, matchedCharacterIds });
    if (invalidCharacterIds.length) return respond(422, { error: 'Unknown character IDs', projectId, shotId, matchedCharacterIds, invalidCharacterIds });
    return respond(200, { success: true, projectId, shotId, matchedCharacterIds, shot: updatedShot });
  } catch (error: any) {
    console.error('[Shot Character Binding]', { projectId, shotId, matchedCharacterIds, error });
    return respond(500, { error: error.message || 'Failed to save shot character binding', projectId, shotId, matchedCharacterIds });
  }
});

// 10. PUT /api/generated-scripts/:id/image - Write back image URL to shot or character
app.put('/api/generated-scripts/:id/image', async (req, res) => {
  try {
    const { id } = req.params;
    const { shotIndex, characterName, imageUrl, views, generation } = req.body;

    if (!imageUrl && !views && !generation) {
      return res.status(400).json({ error: 'imageUrl, views, or generation is required' });
    }

    let found = false;
    let errorMsg = '';
    let updatedScript: any = null;
    await mutateDb((db) => {
      const scriptIndex = db.generated_scripts.findIndex((s: any) => s.id === id);
      if (scriptIndex === -1) {
        errorMsg = 'Script not found';
        return;
      }

      const script = db.generated_scripts[scriptIndex];

      if (typeof shotIndex === 'number') {
        if (script.newShots && script.newShots[shotIndex]) {
          const shot = script.newShots[shotIndex];
          if (imageUrl) {
            shot.imageUrl = imageUrl;
            shot.generatedImageUrl = imageUrl;
          }
          if (generation) {
            shot.imageGeneration = generation;
            shot.imageGenerations = [...(shot.imageGenerations || []), generation];
          }
        } else {
          errorMsg = 'Shot index not found';
          return;
        }
      } else if (characterName) {
        const char = script.newCharacters.find((c: any) => c.name === characterName);
        if (char) {
          if (imageUrl) {
            char.avatarUrl = imageUrl;
          }
          if (views) {
            char.views = views;
            if (views.front) {
              char.avatarUrl = views.front; // Default front view as avatarUrl
            }
          }
          if (generation) {
            char.imageGeneration = generation;
            char.imageGenerations = [...(char.imageGenerations || []), generation];
          }
        } else {
          errorMsg = 'Character not found';
          return;
        }
      } else {
        errorMsg = 'Either shotIndex or characterName must be provided';
        return;
      }

      db.generated_scripts[scriptIndex] = script;
      updatedScript = script;
      found = true;
    });

    if (errorMsg) {
      return res.status(errorMsg.includes('not found') ? 404 : 400).json({ error: errorMsg });
    }

    res.json({ success: true, script: updatedScript });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update script image' });
  }
});

// 10.5. POST /api/translate-character - Translate character Chinese profile into clean English description
app.post('/api/translate-character', async (req, res) => {
  const { name, role, clothing, personality } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Character name is required' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.json({ englishDescription: `${name}, role: ${role}, appearance: ${clothing}, personality: ${personality}` });
  }

  const ai = new GoogleGenAI({ apiKey });
  const systemPrompt = `You are an expert prompt engineer. Translate the following Chinese character profile into a highly detailed, concise, and professional English description (under 80 words) optimized for image generation. Focus strictly on appearance, hairstyle, face, clothing, and character archetype. Do not include camera directions, views, backgrounds, or styles. Output only the pure English description, no other text, prefix, or explanation.`;

  const rawInput = `å§“å: ${name}\nè§’è‰²: ${role}\nå¤–è²Œæœé¥°: ${clothing}\næ€§æ ¼ç‰¹è´¨: ${personality}`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        { text: systemPrompt },
        { text: rawInput }
      ]
    });
    const resultText = response.text?.trim() || `${name}, role: ${role}, appearance: ${clothing}, personality: ${personality}`;
    console.log(`[Character Translator] Translated character "${name}" to: "${resultText}"`);
    return res.json({ englishDescription: resultText });
  } catch (err: any) {
    console.error('[Translate Character Error]', err);
    const fallbackDesc = `${name}, role is ${role}, appearance: ${clothing}, personality: ${personality}`;
    return res.json({ englishDescription: fallbackDesc, error: err.message || 'Translation failed' });
  }
});

// 10.8. GET /api/pollinations-proxy - Proxy requests to Pollinations AI to bypass network/CORS restrictions
let pollinationsQueue = Promise.resolve();

async function fetchWithRetry(url: string, retries = 3, initialDelay = 1000): Promise<Response> {
  let delay = initialDelay;
  let lastError: any;
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`[Proxy] Fetching attempt ${i + 1}/${retries}: ${url}`);
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      });
      if (response.status === 429) {
        console.warn(`[Proxy] Got 429 from Pollinations. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      return response;
    } catch (err: any) {
      lastError = err;
      console.warn(`[Proxy] Fetch failed: ${err.message}. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
  throw lastError || new Error(`Failed to fetch after ${retries} retries`);
}

app.get('/api/pollinations-proxy', async (req, res) => {
  const { prompt, width, height } = req.query;
  if (!prompt) {
    return res.status(400).send('Prompt is required');
  }

  const w = width || '512';
  const h = height || '768';
  // Replace slashes with comma-space to avoid path traversal / routing issues on Pollinations side
  const cleanPrompt = (prompt as string).replace(/\//g, ', ');
  const encodedPrompt = encodeURIComponent(cleanPrompt);
  const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${w}&height=${h}&nologo=true`;

  try {
    const bufferData = await new Promise<{ buffer: Buffer; contentType: string }>(async (resolve, reject) => {
      pollinationsQueue = pollinationsQueue
        .then(async () => {
          try {
            const fetchResponse = await fetchWithRetry(pollinationsUrl);
            if (!fetchResponse.ok) {
              throw new Error(`Pollinations returned status ${fetchResponse.status}`);
            }
            const contentType = fetchResponse.headers.get('content-type') || 'image/jpeg';
            const arrayBuffer = await fetchResponse.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            resolve({ buffer, contentType });
          } catch (err) {
            reject(err);
          }
          // Small cooling time in the queue (500ms) to prevent hitting Pollinations too fast
          await new Promise(r => setTimeout(r, 500));
        })
        .catch((err) => {
          // Keep queue alive even if this request failed
          console.error('[Proxy Queue Internal Chain Error]', err);
        });
    });

    res.setHeader('Content-Type', bufferData.contentType);
    return res.send(bufferData.buffer);
  } catch (err: any) {
    console.error(`[Proxy Error]`, err);
    return res.status(500).send('Proxy error: ' + err.message);
  }
});


// Helper to resolve internal proxy or relative image URLs to a public URL for Kling API
function resolveToPublicUrl(imageUrl: string): string {
  if (!imageUrl) return '';
  if (imageUrl.startsWith('/api/pollinations-proxy')) {
    try {
      const parsedUrl = new URL(imageUrl, 'http://localhost');
      const prompt = parsedUrl.searchParams.get('prompt') || '';
      const w = parsedUrl.searchParams.get('width') || '768';
      const h = parsedUrl.searchParams.get('height') || '512';
      const cleanPrompt = prompt.replace(/\//g, ', ');
      const encodedPrompt = encodeURIComponent(cleanPrompt);
      return `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${w}&height=${h}&nologo=true`;
    } catch (e) {
      console.error('[resolveToPublicUrl] Failed to parse proxy URL:', e);
    }
  }
  return imageUrl;
}

// Helper to download shot images from local proxy, local uploads, or absolute pollinations URLs
async function downloadShotImage(imageUrl: string, localDestPath: string) {
  if (!imageUrl) throw new Error('Image URL is empty');

  let targetUrl = imageUrl;

  // If it's our local proxy URL, parse and reconstruct the real Pollinations URL
  if (imageUrl.startsWith('/api/pollinations-proxy')) {
    try {
      const parsedUrl = new URL(imageUrl, 'http://localhost');
      const prompt = parsedUrl.searchParams.get('prompt') || '';
      const w = parsedUrl.searchParams.get('width') || '768';
      const h = parsedUrl.searchParams.get('height') || '512';
      const cleanPrompt = prompt.replace(/\//g, ', ');
      const encodedPrompt = encodeURIComponent(cleanPrompt);
      targetUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${w}&height=${h}&nologo=true`;
    } catch (e) {
      console.error('[Download Image] Failed to parse local proxy URL, using fallback:', e);
    }
  } else if (imageUrl.startsWith('/uploads/')) {
    // If it's a locally uploaded file, copy it directly
    const localSrcPath = path.join(__dirname, imageUrl.substring(1)); // Remove leading slash
    if (fs.existsSync(localSrcPath)) {
      fs.copyFileSync(localSrcPath, localDestPath);
      return;
    }
  }

  // CONTENT HASH CACHING:
  const hash = crypto.createHash('sha256').update(targetUrl).digest('hex');
  let ext = '.jpg';
  try {
    const urlObj = new URL(targetUrl);
    const pathname = urlObj.pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
    if (match) {
      ext = `.${match[1]}`;
    }
  } catch (e) {}

  const cacheFilename = `${hash}${ext}`;
  const cacheDir = path.join(UPLOADS_DIR, 'images');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  const cacheFilePath = path.join(cacheDir, cacheFilename);

  if (fs.existsSync(cacheFilePath)) {
    console.log(`[Cache Hit] Image already exists in cache: ${cacheFilename}`);
    fs.copyFileSync(cacheFilePath, localDestPath);
    return;
  }

  // Fetch using fetchWithRetry to ensure we don't hit 429 and get the actual image
  console.log(`[Cache Miss] Downloading image to cache from: ${targetUrl}`);
  const res = await fetchWithRetry(targetUrl);
  if (!res.ok) {
    throw new Error(`Failed to download image from ${targetUrl}, status ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  fs.writeFileSync(cacheFilePath, buffer);
  fs.copyFileSync(cacheFilePath, localDestPath);
  console.log(`[Cache Save] Saved downloaded image to cache: ${cacheFilename}`);
}

function escapeDrawtextText(text: string): string {
  if (!text) return '';
  return text
    .replace(/'/g, '"') // Replace single quotes with double quotes
    .replace(/:/g, 'ï¼š') // Replace English colons with Chinese colons
    .replace(/\\/g, '')  // Remove backslashes
    .replace(/\n/g, ' ') // Replace newlines with space
    .trim();
}

function srtTimestamp(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const ms = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function ffmpegSubtitlePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

// 10.91. GET /api/bgm-list - List uploaded BGM audio files
app.get('/api/bgm-list', (req, res) => {
  try {
    if (!fs.existsSync(UPLOADS_DIR)) {
      return res.json([]);
    }
    const files = fs.readdirSync(UPLOADS_DIR);
    const audioExtensions = ['.mp3', '.wav', '.m4a', '.aac', '.ogg'];
    const bgmFiles = files
      .filter(f => audioExtensions.includes(path.extname(f).toLowerCase()))
      .map(f => ({
        filename: f,
        url: `/uploads/${f}`
      }));
    res.json(bgmFiles);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list BGM files: ' + err.message });
  }
});

// 10.92. POST /api/upload-bgm - Upload background music track
app.post('/api/upload-bgm', upload.single('bgm'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    res.json({
      filename: req.file.filename,
      url: `/uploads/${req.file.filename}`
    });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload BGM: ' + err.message });
  }
});

// Helper: JWT Generator for Kling AI (Legacy AK/SK API authentication)
function generateKlingToken(accessKey: string, secretKey: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: accessKey,
    exp: now + 1800, // 30 minutes
    nbf: now - 5
  };

  const base64UrlEncode = (obj: any) => {
    return Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  };

  const headerStr = base64UrlEncode(header);
  const payloadStr = base64UrlEncode(payload);
  const signatureInput = `${headerStr}.${payloadStr}`;

  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(signatureInput)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${signatureInput}.${signature}`;
}

// Global map to keep track of mock animation progress in memory
const mockTasks = new Map<string, {
  status: 'submitted' | 'processing' | 'succeed' | 'failed';
  progress: number;
  scriptId: string;
  shotIndex: number;
  prompt: string;
  imageUrl: string;
  createdAt: number;
}>();

// 10.925. POST /api/generate-animation - Generate image-to-video using Kling AI or Mock Fallback
app.post('/api/generate-animation', async (req, res) => {
  const { scriptId, shotIndex, imageUrl, prompt } = req.body;

  if (!scriptId || shotIndex === undefined || !imageUrl) {
    return res.status(400).json({ error: 'scriptId, shotIndex, and imageUrl are required' });
  }

  const checkDb = readDb();
  const checkScript = checkDb.generated_scripts.find((s: any) => s.id === scriptId);
  if (!checkScript) {
    return res.status(404).json({ error: 'Script not found' });
  }

  const checkShot = checkScript.newShots?.[shotIndex];
  if (!checkShot) {
    return res.status(404).json({ error: 'Shot index not found in script' });
  }

  const ak = process.env.KLING_ACCESS_KEY;
  const sk = process.env.KLING_SECRET_KEY;
  const apiKey = process.env.KLING_API_KEY;

  const isReal = !!(apiKey || (ak && sk));

  if (!isReal) {
    // Mock Fallback Mode
    const taskId = `mock_${Math.random().toString(36).substring(2, 9)}`;
    mockTasks.set(taskId, {
      status: 'submitted',
      progress: 0,
      scriptId,
      shotIndex,
      prompt: prompt || checkShot.description || 'cinematic motion',
      imageUrl,
      createdAt: Date.now()
    });

    // Update DB
    await mutateDb((db) => {
      const script = db.generated_scripts.find((s: any) => s.id === scriptId);
      const shot = script?.newShots?.[shotIndex];
      if (shot) {
        shot.videoTaskId = taskId;
        shot.videoStatus = 'submitted';
        shot.videoUrl = undefined;
      }
    });

    console.log(`[Kling Mock] Created mock animation task: ${taskId} for script ${scriptId} shot ${shotIndex}`);
    return res.json({ success: true, taskId, videoStatus: 'submitted' });
  }

  // Real Kling API Mode
  let tempImgPath = '';
  try {
    let authHeader = '';
    if (apiKey) {
      authHeader = `Bearer ${apiKey}`;
    } else if (ak && sk) {
      const jwtToken = generateKlingToken(ak, sk);
      authHeader = `Bearer ${jwtToken}`;
    }

    // 1. Download image locally first to ensure base64 parsing is clean
    tempImgPath = path.join(__dirname, `temp_kling_input_${Date.now()}.jpg`);
    console.log(`[Kling API] Downloading reference image: ${imageUrl}`);
    await downloadShotImage(imageUrl, tempImgPath);

    // 2. Read image and convert to raw Base64 string (no data prefix)
    const base64Image = fs.readFileSync(tempImgPath).toString('base64');

    // 3. Submit task to Kling AI
    const apiEndpoint = 'https://api.klingai.com/v1/videos/image2video';
    console.log(`[Kling API] Submitting image2video task to ${apiEndpoint}`);

    const response = await fetch(apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify({
        model_name: 'kling-v1-6',
        image: base64Image,
        prompt: prompt || checkShot.description || 'cinematic motion',
        duration: 5
      })
    });

    const result = await response.json();
    if (!response.ok || result.code !== 0) {
      throw new Error(result.message || `Kling API error (status ${response.status})`);
    }

    const taskId = result.data?.task_id;
    if (!taskId) {
      throw new Error('Kling API response did not return a task_id');
    }

    console.log(`[Kling API] Task successfully created: ${taskId}`);

    // Update DB
    await mutateDb((db) => {
      const script = db.generated_scripts.find((s: any) => s.id === scriptId);
      const shot = script?.newShots?.[shotIndex];
      if (shot) {
        shot.videoTaskId = taskId;
        shot.videoStatus = 'submitted';
        shot.videoUrl = undefined;
      }
    });

    return res.json({ success: true, taskId, videoStatus: 'submitted' });
  } catch (err: any) {
    console.error('[Kling API Error]', err);
    res.status(500).json({ error: 'Kling API submission failed: ' + err.message });
  } finally {
    if (tempImgPath && fs.existsSync(tempImgPath)) {
      try {
        fs.unlinkSync(tempImgPath);
      } catch (e) {
        console.error('Failed to delete temp image file:', e);
      }
    }
  }
});

// 10.926. GET /api/animation-status/:taskId - Check status of generation
app.get('/api/animation-status/:taskId', async (req, res) => {
  const { taskId } = req.params;

  if (!taskId) {
    return res.status(400).json({ error: 'taskId is required' });
  }

  const db = readDb();
  let foundScript: any = null;
  let foundShot: any = null;

  // Find the script and shot associated with this taskId
  for (const s of db.generated_scripts) {
    const shot = s.newShots?.find((sh: any) => sh.videoTaskId === taskId);
    if (shot) {
      foundScript = s;
      foundShot = shot;
      break;
    }
  }

  const updateShotStatus = async (status: string, videoUrl?: string) => {
    await mutateDb((db) => {
      for (const s of db.generated_scripts) {
        const shot = s.newShots?.find((sh: any) => sh.videoTaskId === taskId);
        if (shot) {
          shot.videoStatus = status;
          if (videoUrl !== undefined) {
            shot.videoUrl = videoUrl;
          }
          break;
        }
      }
    });
  };

  // Handle mock tasks
  if (taskId.startsWith('mock_')) {
    const task = mockTasks.get(taskId);
    if (!task) {
      // If server restarted, recreate task in processing state
      mockTasks.set(taskId, {
        status: 'processing',
        progress: 50,
        scriptId: foundScript?.id || '',
        shotIndex: foundScript?.newShots?.indexOf(foundShot) ?? -1,
        prompt: foundShot?.description || 'cinematic motion',
        imageUrl: foundShot?.generatedImageUrl || foundShot?.imageUrl || '',
        createdAt: Date.now()
      });
      return res.json({ task_status: 'processing', progress: 50 });
    }

    // Increment progress
    task.progress += 25;
    if (task.progress < 100) {
      task.status = 'processing';
      await updateShotStatus('processing');
      return res.json({ task_status: 'processing', progress: task.progress });
    }

    // Task finished - generate mock MP4 using Mandelbrot zoom
    try {
      const videosDir = path.join(UPLOADS_DIR, 'videos');
      if (!fs.existsSync(videosDir)) {
        fs.mkdirSync(videosDir, { recursive: true });
      }

      const mockTemplatePath = path.join(videosDir, 'mock_template.mp4');
      if (!fs.existsSync(mockTemplatePath)) {
        console.log(`[Kling Mock] Generating mock video template at ${mockTemplatePath}...`);
        const generateCmd = `${FFMPEG_COMMAND} -f lavfi -i "mandelbrot=size=1280x720:rate=25" -t 4 -c:v libx264 -pix_fmt yuv420p -an -y "${mockTemplatePath}"`;
        await execPromise(generateCmd);
      }

      const localVidPath = path.join(videosDir, `${taskId}.mp4`);
      fs.copyFileSync(mockTemplatePath, localVidPath);

      const videoUrl = `/uploads/videos/${taskId}.mp4`;
      task.status = 'succeed';
      task.progress = 100;

      await updateShotStatus('succeed', videoUrl);

      console.log(`[Kling Mock] Animation generated successfully: ${videoUrl}`);
      return res.json({ task_status: 'succeed', videoUrl });
    } catch (err: any) {
      console.error('[Kling Mock Video Generation Error]', err);
      task.status = 'failed';
      await updateShotStatus('failed');
      return res.status(500).json({ error: 'Mock video generation failed: ' + err.message });
    }
  }

  // Handle Real Kling API tasks
  const ak = process.env.KLING_ACCESS_KEY;
  const sk = process.env.KLING_SECRET_KEY;
  const apiKey = process.env.KLING_API_KEY;

  if (!apiKey && (!ak || !sk)) {
    return res.status(400).json({ error: 'Kling API credentials are not configured in .env' });
  }

  try {
    let authHeader = '';
    if (apiKey) {
      authHeader = `Bearer ${apiKey}`;
    } else if (ak && sk) {
      const jwtToken = generateKlingToken(ak, sk);
      authHeader = `Bearer ${jwtToken}`;
    }

    const apiEndpoint = `https://api.klingai.com/v1/tasks/${taskId}`;
    console.log(`[Kling API] Querying task status: ${apiEndpoint}`);

    const response = await fetch(apiEndpoint, {
      method: 'GET',
      headers: {
        'Authorization': authHeader
      }
    });

    const result = await response.json();
    if (!response.ok || result.code !== 0) {
      throw new Error(result.message || `Kling API status check error (status ${response.status})`);
    }

    const taskData = result.data;
    const taskStatus = taskData?.task_status; // submitted, processing, succeed, failed

    console.log(`[Kling API] Task ${taskId} status: ${taskStatus}`);

    if (taskStatus === 'succeed') {
      const cdnUrl = taskData.task_result?.videos?.[0]?.url;
      if (!cdnUrl) {
        throw new Error('Kling API task succeeded but returned no video url');
      }

      // Download the CDN video locally to uploads/videos/
      const videosDir = path.join(UPLOADS_DIR, 'videos');
      if (!fs.existsSync(videosDir)) {
        fs.mkdirSync(videosDir, { recursive: true });
      }

      const localVidPath = path.join(videosDir, `${taskId}.mp4`);
      console.log(`[Kling API] Downloading generated video from CDN: ${cdnUrl}`);

      const videoRes = await fetch(cdnUrl);
      if (!videoRes.ok) {
        throw new Error(`Failed to download video from CDN (status ${videoRes.status})`);
      }

      const arrayBuffer = await videoRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      fs.writeFileSync(localVidPath, buffer);

      const videoUrl = `/uploads/videos/${taskId}.mp4`;

      await updateShotStatus('succeed', videoUrl);

      return res.json({ task_status: 'succeed', videoUrl });
    } else if (taskStatus === 'failed') {
      await updateShotStatus('failed');
      return res.json({ task_status: 'failed', error: taskData?.task_status_msg || 'Generation failed' });
    } else {
      // submitted or processing
      await updateShotStatus(taskStatus);
      return res.json({ task_status: taskStatus });
    }
  } catch (err: any) {
    console.error('[Kling API Status Check Error]', err);
    res.status(500).json({ error: 'Failed to query task status: ' + err.message });
  }
});

// 10.927. POST /api/generate-video - Add image-to-video using Kling API and poll internally until succeeded
app.post('/api/generate-video', async (req, res) => {
  const { imageUrl, prompt, scriptId, shotIndex } = req.body;

  if (!imageUrl) {
    return res.status(400).json({ error: 'imageUrl is required' });
  }

  const apiKey = process.env.KLING_API_KEY;
  const isReal = !!apiKey;

  const updateGenerateVideoSubmitted = async (taskId: string) => {
    await mutateDb((db) => {
      if (scriptId && shotIndex !== undefined) {
        const script = db.generated_scripts.find((s: any) => s.id === scriptId);
        if (script) {
          const shot = script.newShots?.[shotIndex];
          if (shot) {
            shot.videoTaskId = taskId;
            shot.videoStatus = 'submitted';
            shot.videoUrl = undefined;
          }
        }
      }
    });
  };

  const updateGenerateVideoStatus = async (status: string, localVideoUrl?: string) => {
    await mutateDb((db) => {
      if (scriptId && shotIndex !== undefined) {
        const script = db.generated_scripts.find((s: any) => s.id === scriptId);
        if (script) {
          const shot = script.newShots?.[shotIndex];
          if (shot) {
            shot.videoStatus = status;
            if (localVideoUrl !== undefined) {
              shot.videoUrl = localVideoUrl;
            }
          }
        }
      }
    });
  };

  if (!isReal) {
    // Mock Mode
    console.log(`[Kling Mock] Generating video in Mock mode for: ${imageUrl}`);

    const taskId = `mock_${Math.random().toString(36).substring(2, 9)}`;
    const totalSteps = 5;

    // Update DB to submitted
    await updateGenerateVideoSubmitted(taskId);

    // Simulate progress in 5 steps (e.g. 5 seconds total)
    for (let i = 1; i <= totalSteps; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      await updateGenerateVideoStatus(i === totalSteps ? 'succeed' : 'processing');
    }

    // Copy mock video template
    try {
      const videosDir = path.join(UPLOADS_DIR, 'videos');
      if (!fs.existsSync(videosDir)) {
        fs.mkdirSync(videosDir, { recursive: true });
      }

      const mockTemplatePath = path.join(videosDir, 'mock_template.mp4');
      if (!fs.existsSync(mockTemplatePath)) {
        const generateCmd = `${FFMPEG_COMMAND} -f lavfi -i "mandelbrot=size=1280x720:rate=25" -t 4 -c:v libx264 -pix_fmt yuv420p -an -y "${mockTemplatePath}"`;
        await execPromise(generateCmd);
      }

      const localVidPath = path.join(videosDir, `${taskId}.mp4`);
      fs.copyFileSync(mockTemplatePath, localVidPath);
      const localVideoUrl = `/uploads/videos/${taskId}.mp4`;

      await updateGenerateVideoStatus('succeed', localVideoUrl);

      return res.json({ success: true, videoUrl: localVideoUrl });
    } catch (e: any) {
      console.error('[Kling Mock error]', e);
      return res.status(500).json({ error: 'Mock video generation failed: ' + e.message });
    }
  }

  // Real Kling API Mode
  try {
    const resolvedUrl = resolveToPublicUrl(imageUrl);
    console.log(`[Kling API] Submitting image2video task to Kling with URL: ${resolvedUrl}`);

    const apiEndpoint = 'https://api.klingai.com/v1/videos/image2video';
    const response = await fetch(apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model_name: 'kling-v1',
        image: resolvedUrl,
        image_url: resolvedUrl,
        prompt: prompt || 'cinematic motion',
        duration: '5',
        mode: 'std'
      })
    });

    const result = await response.json();
    if (!response.ok || result.code !== 0) {
      throw new Error(result.message || `Kling API error (status ${response.status})`);
    }

    const taskId = result.data?.task_id;
    if (!taskId) {
      throw new Error('Kling API response did not return a task_id');
    }

    console.log(`[Kling API] Task successfully created: ${taskId}`);

    // Update DB to submitted
    await updateGenerateVideoSubmitted(taskId);

    // Polling Loop
    const pollInterval = 5000;
    const maxPollAttempts = 40; // Max 200 seconds
    let attempts = 0;
    let videoUrl = '';
    let finalStatus = 'failed';

    while (attempts < maxPollAttempts) {
      attempts++;
      console.log(`[Kling API] Polling task ${taskId} (attempt ${attempts}/${maxPollAttempts})...`);

      const statusEndpoint = `https://api.klingai.com/v1/videos/image2video/${taskId}`;
      const statusRes = await fetch(statusEndpoint, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      const statusResult = await statusRes.json();
      if (statusRes.ok && statusResult.code === 0) {
        const taskData = statusResult.data;
        const currentStatus = taskData?.status || taskData?.task_status;
        console.log(`[Kling API] Task ${taskId} status: ${currentStatus}`);

        // Update DB
        await updateGenerateVideoStatus(currentStatus);

        if (currentStatus === 'succeed') {
          videoUrl = taskData.task_result?.videos?.[0]?.url || taskData.url || taskData.video_url;
          finalStatus = 'succeed';
          break;
        } else if (currentStatus === 'failed') {
          throw new Error(taskData?.task_status_msg || 'Kling API task failed');
        }
      } else {
        console.warn(`[Kling API] Polling status returned error:`, statusResult);
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    if (finalStatus !== 'succeed' || !videoUrl) {
      throw new Error('Task timed out or did not return a valid video URL');
    }

    console.log(`[Kling API] Task succeeded! CDN Video URL: ${videoUrl}`);

    // Download CDN video locally
    const videosDir = path.join(UPLOADS_DIR, 'videos');
    if (!fs.existsSync(videosDir)) {
      fs.mkdirSync(videosDir, { recursive: true });
    }

    const localVidPath = path.join(videosDir, `${taskId}.mp4`);
    console.log(`[Kling API] Downloading CDN video locally: ${videoUrl}`);
    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) {
      throw new Error(`Failed to download video from CDN (status ${videoRes.status})`);
    }

    const arrayBuffer = await videoRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(localVidPath, buffer);

    const localVideoUrl = `/uploads/videos/${taskId}.mp4`;

    // Save final video URL to DB
    await updateGenerateVideoStatus('succeed', localVideoUrl);

    return res.json({ success: true, videoUrl: localVideoUrl });

  } catch (err: any) {
    console.error('[Kling API generate-video Error]', err);

    // Update DB to failed
    await updateGenerateVideoStatus('failed');

    return res.status(500).json({ error: err.message || 'Kling API video generation failed' });
  }
});

// 10.93. POST /api/compile-preview - Compile storyboard into dynamic animatic video
app.post('/api/compile-preview', async (req, res) => {
  const { scriptId, durationPerShot, bgmFilename } = req.body;

  if (!scriptId) {
    return res.status(400).json({ error: 'scriptId is required' });
  }

  const duration = Number(durationPerShot) || 4; // Default 4 seconds
  const db = readDb();
  const script = db.generated_scripts.find((s: any) => s.id === scriptId);
  if (!script) {
    return res.status(404).json({ error: 'Script not found' });
  }

  const shots = script.newShots || [];
  if (shots.length === 0) {
    return res.status(400).json({ error: 'Script has no storyboard shots' });
  }

  // Setup temporary workspace directory
  const tempDir = path.join(__dirname, `temp_animatic_${scriptId}_${Date.now()}`);
  const previewsDir = path.join(UPLOADS_DIR, 'previews');

  try {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(previewsDir, { recursive: true });

    console.log(`[Animatic] Temporary dir created: ${tempDir}`);

    // Download shot images and compile individual video chunks
    const videoChunks: string[] = [];

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const localVidPath = path.join(tempDir, `shot_${i}.mp4`);

      const subtitleSource = shot.description || '';
      const subtitlePath = path.join(tempDir, `shot_${i}.srt`);
      const subtitleText = subtitleSource.replace(/\r\n?/g, '\n').trim();
      const srt = `\uFEFF1\n00:00:00,000 --> ${srtTimestamp(Math.max(0.1, duration))}\n${subtitleText}\n`;
      fs.writeFileSync(subtitlePath, srt, { encoding: 'utf8' });
      const subtitleFilterPath = ffmpegSubtitlePath(subtitlePath);
      const fontName = process.platform === 'win32' ? 'Microsoft YaHei' : process.platform === 'darwin' ? 'PingFang SC' : 'Noto Sans CJK SC';
      console.log('[SubtitleDiagnostic]', JSON.stringify({
        scriptId,
        shotIndex: i,
        shotId: shot.id || null,
        sourceField: 'shot.description',
        sourceText: subtitleSource,
        sourceLength: subtitleSource.length,
        sourceUtf8Hex: Buffer.from(subtitleSource, 'utf8').toString('hex'),
        subtitlePath,
        subtitleEncoding: 'utf8-bom',
        subtitleBytes: fs.statSync(subtitlePath).size,
        fontName,
      }));

      // UTF-8 SRT is rendered by libass, avoiding drawtext escaping and Unicode parsing issues.
      const vfString = `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fade=t=in:st=0:d=0.5,fade=t=out:st=${Math.max(0, duration - 0.5)}:d=0.5,subtitles=filename='${subtitleFilterPath}':charenc=UTF-8:force_style='FontName=${fontName},FontSize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=3,Outline=1,Shadow=0,MarginV=32,Alignment=2'`;
      console.log('[SubtitleDiagnostic:Filter]', JSON.stringify({ scriptId, shotIndex: i, vfString }));

      const localInputVideoPath = shot.videoUrl ? path.join(__dirname, shot.videoUrl.substring(1)) : '';
      const hasVideo = localInputVideoPath && fs.existsSync(localInputVideoPath);

      if (hasVideo) {
        console.log(`[Animatic] Compiling shot ${i + 1} using generated video clip: ${shot.videoUrl}`);
        const cmd = `${FFMPEG_COMMAND} -i "${localInputVideoPath}" -an -t ${duration} -vf "${vfString}" -c:v libx264 -pix_fmt yuv420p -y "${localVidPath}"`;
        await execPromise(cmd);
      } else {
        const imageUrl = shot.generatedImageUrl || shot.imageUrl;
        if (!imageUrl) {
          throw new Error(`Shot ${i + 1} has no image URL`);
        }

        const localImgPath = path.join(tempDir, `shot_${i}.jpg`);
        console.log(`[Animatic] Downloading shot ${i + 1} image...`);
        await downloadShotImage(imageUrl, localImgPath);

        console.log(`[Animatic] Encoding shot ${i + 1} video chunk from image...`);
        const cmd = `${FFMPEG_COMMAND} -loop 1 -i "${localImgPath}" -t ${duration} -vf "${vfString}" -c:v libx264 -pix_fmt yuv420p -y "${localVidPath}"`;
        await execPromise(cmd);
      }

      videoChunks.push(localVidPath);
    }

    // Create concat.txt
    const concatFilePath = path.join(tempDir, 'concat.txt');
    const concatContent = videoChunks.map(v => `file '${v}'`).join('\n');
    fs.writeFileSync(concatFilePath, concatContent, 'utf8');

    // Concatenate chunks (no re-encoding, extremely fast)
    const combinedVidPath = path.join(tempDir, 'combined.mp4');
    const concatCmd = `${FFMPEG_COMMAND} -f concat -safe 0 -i "${concatFilePath}" -c copy -y "${combinedVidPath}"`;
    console.log(`[Animatic] Concatenating all video chunks...`);
    await execPromise(concatCmd);

    // Apply BGM
    const finalVidFilename = `${scriptId}-${Date.now()}.mp4`;
    const finalVidPath = path.join(previewsDir, finalVidFilename);
    const totalDuration = shots.length * duration;

    if (bgmFilename) {
      const bgmPath = path.join(UPLOADS_DIR, bgmFilename);
      if (fs.existsSync(bgmPath)) {
        console.log(`[Animatic] Mixing BGM: ${bgmFilename}...`);
        const bgmCmd = `${FFMPEG_COMMAND} -i "${combinedVidPath}" -stream_loop -1 -i "${bgmPath}" -filter_complex "[1:a]afade=t=out:st=${totalDuration - 1.5}:d=1.5[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -shortest -y "${finalVidPath}"`;
        await execPromise(bgmCmd);
      } else {
        console.warn(`[Animatic] BGM file not found at ${bgmPath}, compiling without BGM`);
        fs.copyFileSync(combinedVidPath, finalVidPath);
      }
    } else {
      console.log(`[Animatic] Compiling with silent audio...`);
      const silentCmd = `${FFMPEG_COMMAND} -i "${combinedVidPath}" -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -c:v copy -c:a aac -shortest -y "${finalVidPath}"`;
      try {
        await execPromise(silentCmd);
      } catch (e) {
        console.warn('[Animatic] Silent audio mix failed, returning silent-less video', e);
        fs.copyFileSync(combinedVidPath, finalVidPath);
      }
    }

    // Clean up temporary directory
    fs.rm(tempDir, { recursive: true, force: true }, (err) => {
      if (err) console.error('[Animatic] Temp cleanup error:', err);
    });

    const previewUrl = `/uploads/previews/${finalVidFilename}`;
    console.log(`[Animatic] Compilation completed successfully! URL: ${previewUrl}`);
    res.json({ success: true, previewUrl });

  } catch (err: any) {
    console.error('[Animatic Error]', err);
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    res.status(500).json({ error: 'Animatic compilation failed: ' + err.message });
  }
});


type ComfyNode = {
  class_type: string;
  inputs: Record<string, any>;
  _meta?: { title?: string };
};

type ComfyWorkflow = Record<string, ComfyNode>;

type ComfyImageOutput = {
  filename: string;
  subfolder?: string;
  type?: string;
};

type ImageTargetContext = {
  projectId?: string;
  targetType?: 'shot' | 'character';
  shotIndex?: number;
  characterName?: string;
};

const DEFAULT_COMFY_NEGATIVE_PROMPT =
  'low quality, blurry, deformed, extra limbs, bad anatomy, text, watermark';

function comfyBaseUrl(): string {
  const configured = (process.env.COMFYUI_API_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '');
  const parsed = new URL(configured);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('COMFYUI_API_URL must use http or https');
  }
  return configured;
}

async function comfyFetch(relativePath: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${comfyBaseUrl()}${relativePath}`, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`ComfyUI HTTP ${response.status}: ${detail || response.statusText}`);
    }
    return response;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`ComfyUI request timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

type ReferenceImageFile = {
  resolvedPath: string;
  exists: boolean;
  size: number;
  mime: string;
  ext: string;
  canRead: boolean;
  buffer?: Buffer;
};

function resolveReferenceImageFile(imageUrl: string, readFile = true): ReferenceImageFile {
  const uploadsRoot = path.resolve(process.cwd(), 'uploads');
  let pathname = String(imageUrl || '').trim();
  let filenameFromQuery = '';
  try {
    const parsed = new URL(pathname, 'http://localhost');
    pathname = decodeURIComponent(parsed.pathname);
    filenameFromQuery = decodeURIComponent(parsed.searchParams.get('filename') || '');
  } catch {
    throw new Error('Reference image URL is invalid');
  }

  let resolvedPath: string;
  if (pathname === '/api/comfy/image') {
    if (!filenameFromQuery || path.basename(filenameFromQuery) !== filenameFromQuery) {
      throw new Error('Reference image filename is invalid');
    }
    resolvedPath = path.resolve(uploadsRoot, 'images', filenameFromQuery);
  } else {
    const relative = pathname.replace(/^\/+/, '').replace(/^uploads[\\/]/, '');
    resolvedPath = path.resolve(uploadsRoot, relative);
  }
  if (resolvedPath !== uploadsRoot && !resolvedPath.startsWith(`${uploadsRoot}${path.sep}`)) {
    throw new Error('Reference image path traversal rejected');
  }

  const exists = fs.existsSync(resolvedPath);
  if (!exists) return { resolvedPath, exists, size: 0, mime: '', ext: path.extname(resolvedPath).toLowerCase(), canRead: false };
  const stat = fs.statSync(resolvedPath);
  const size = stat.isFile() ? stat.size : 0;
  const ext = path.extname(resolvedPath).toLowerCase();
  const mimeByExt: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  const mime = mimeByExt[ext] || '';
  if (!readFile) return { resolvedPath, exists, size, mime, ext, canRead: stat.isFile() && size > 0 && !!mime };

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(resolvedPath);
  } catch (error: any) {
    throw new Error(`Reference image read failed: ${error.message}`);
  }
  const validSignature = (mime === 'image/png' && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    || (mime === 'image/jpeg' && buffer[0] === 0xff && buffer[1] === 0xd8)
    || (mime === 'image/webp' && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP');
  return { resolvedPath, exists, size: buffer.length, mime, ext, canRead: buffer.length > 0 && validSignature, buffer };
}

type ComfyPermissionCheck = { path: string; exists: boolean; writable: boolean; error: string | null };

function probeDirectoryWritable(directory: string): ComfyPermissionCheck {
  const result: ComfyPermissionCheck = { path: directory, exists: fs.existsSync(directory), writable: false, error: null };
  if (!result.exists) {
    result.error = 'directory not found';
    return result;
  }
  const probe = path.join(directory, `.codex-write-test-${process.pid}-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(probe, 'permission-test', { flag: 'wx' });
    fs.unlinkSync(probe);
    result.writable = true;
  } catch (error: any) {
    result.error = error.message || String(error);
    try { if (fs.existsSync(probe)) fs.unlinkSync(probe); } catch {}
  }
  return result;
}

async function runningComfyProcesses(comfyRoot: string): Promise<Array<{ processId: number; name: string; commandLine: string }>> {
  if (process.platform !== 'win32') return [];
  const escapedRoot = comfyRoot.replace(/'/g, "''");
  const command = `powershell.exe -NoProfile -Command "$items = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -like '*${escapedRoot.replace(/\\/g, '\\\\')}*') -and ($_.Name -match 'python|comfy') } | Select-Object ProcessId,Name,CommandLine; $items | ConvertTo-Json -Compress"`;
  try {
    const { stdout } = await execPromise(command, { windowsHide: true, timeout: 8_000 });
    const parsed = stdout.trim() ? JSON.parse(stdout.trim()) : [];
    const matches = (Array.isArray(parsed) ? parsed : [parsed]).map((item: any) => ({ processId: Number(item.ProcessId), name: String(item.Name || ''), commandLine: String(item.CommandLine || '') }));
    if (matches.length) return matches;
  } catch (error: any) {
    console.warn('[ComfyPreflight:ProcessCheckFailed]', error.message);
  }
  try {
    const fallback = `powershell.exe -NoProfile -Command "$items = Get-NetTCPConnection -State Listen -LocalPort 8001 -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; [pscustomobject]@{ ProcessId = $_.OwningProcess; Name = $p.ProcessName; CommandLine = '[command line unavailable; detected by port 8001]' } }; $items | ConvertTo-Json -Compress"`;
    const { stdout } = await execPromise(fallback, { windowsHide: true, timeout: 8_000 });
    const parsed = stdout.trim() ? JSON.parse(stdout.trim()) : [];
    const matches = (Array.isArray(parsed) ? parsed : [parsed]).map((item: any) => ({ processId: Number(item.ProcessId), name: String(item.Name || ''), commandLine: String(item.CommandLine || '') }));
    if (matches.length) return matches;
  } catch (error: any) {
    console.warn('[ComfyPreflight:PortOwnerCheckFailed]', error.message);
  }
  try {
    const { stdout } = await execPromise('netstat -ano -p tcp', { windowsHide: true, timeout: 8_000 });
    const pids = [...new Set(stdout.split(/\r?\n/)
      .filter(line => /:8001\s+.*LISTENING\s+\d+\s*$/i.test(line))
      .map(line => Number(line.trim().split(/\s+/).at(-1)))
      .filter(Boolean))];
    const detected = pids.map(processId => ({ processId, name: 'ComfyUI port owner', commandLine: '[detected by netstat port 8001]' }));
    try {
      const escapedRoot = comfyRoot.replace(/'/g, "''");
      const rootCommand = `powershell.exe -NoProfile -Command "$items = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith('${escapedRoot}', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { [pscustomobject]@{ ProcessId=$_.Id; Name=$_.ProcessName; CommandLine=('[command line unavailable] executable=' + $_.Path) } }; $items | ConvertTo-Json -Compress"`;
      const rootResult = await execPromise(rootCommand, { windowsHide: true, timeout: 8_000 });
      const parsed = rootResult.stdout.trim() ? JSON.parse(rootResult.stdout.trim()) : [];
      for (const item of (Array.isArray(parsed) ? parsed : [parsed])) detected.push({ processId: Number(item.ProcessId), name: String(item.Name || ''), commandLine: String(item.CommandLine || '') });
    } catch (error: any) {
      console.warn('[ComfyPreflight:RootProcessCheckFailed]', error.message);
    }
    return [...new Map(detected.map(item => [item.processId, item])).values()];
  } catch (error: any) {
    console.warn('[ComfyPreflight:NetstatCheckFailed]', error.message);
    return [];
  }
}

async function comfyPermissionPreflight() {
  const comfyRoot = path.resolve(process.env.COMFYUI_ROOT || 'C:\\Users\\Owner\\Documents\\ComfyUI');
  let online = false;
  let onlineError: string | null = null;
  try {
    await comfyFetch('/system_stats', {}, 5_000);
    online = true;
  } catch (error: any) {
    onlineError = error.message || String(error);
  }
  const input = probeDirectoryWritable(path.join(comfyRoot, 'input'));
  const output = probeDirectoryWritable(path.join(comfyRoot, 'output'));
  const userDefault = probeDirectoryWritable(path.join(comfyRoot, 'user', 'default'));
  const processes = await runningComfyProcesses(comfyRoot);
  const dbCandidates = [path.join(comfyRoot, 'user', 'default', 'comfyui.db'), path.join(comfyRoot, 'comfyui.db')];
  const dbPath = dbCandidates.find(candidate => fs.existsSync(candidate)) || dbCandidates[0];
  let dbLocked = false;
  let dbLockError: string | null = null;
  if (fs.existsSync(dbPath)) {
    try {
      const handle = fs.openSync(dbPath, 'r+');
      fs.closeSync(handle);
    } catch (error: any) {
      dbLocked = true;
      dbLockError = error.message || String(error);
    }
  }
  return { comfyUrl: comfyBaseUrl(), comfyRoot, online, onlineError, input, output, userDefault, processes, multipleProcesses: processes.length > 1, dbPath, dbExists: fs.existsSync(dbPath), dbLocked, dbLockError };
}

function validateWorkflow(value: unknown): ComfyWorkflow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ComfyUI workflow must be an API-format JSON object');
  }
  const workflow = value as Record<string, any>;
  const entries = Object.entries(workflow);
  if (!entries.length) throw new Error('ComfyUI workflow is empty');
  for (const [nodeId, node] of entries) {
    if (!node || typeof node !== 'object' || typeof node.class_type !== 'string' || !node.inputs || typeof node.inputs !== 'object') {
      throw new Error(`ComfyUI node ${nodeId} is not in API format (class_type/inputs missing)`);
    }
  }
  return workflow as ComfyWorkflow;
}

function loadCustomComfyWorkflow(): ComfyWorkflow | null {
  const workflowPath = path.resolve(__dirname, process.env.COMFYUI_WORKFLOW_PATH || 'comfyui_workflow.json');
  if (!fs.existsSync(workflowPath)) return null;
  const parsed = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  // Accept a raw API export and the { prompt: ... } wrapper returned by /history.
  return validateWorkflow(parsed?.prompt || parsed);
}

async function getComfyCheckpoint(): Promise<string> {
  const configured = process.env.COMFYUI_CKPT_NAME?.trim();
  if (configured) return configured;
  const response = await comfyFetch('/object_info/CheckpointLoaderSimple', {}, 10_000);
  const info: any = await response.json();
  const choices = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
  if (!Array.isArray(choices) || !choices.length) {
    throw new Error('ComfyUI has no available checkpoint; install one or set COMFYUI_CKPT_NAME');
  }
  return String(choices[0]);
}

async function getComfyCheckpointsList(): Promise<string[]> {
  try {
    const response = await comfyFetch('/object_info/CheckpointLoaderSimple', {}, 5000);
    if (response.ok) {
      const info: any = await response.json();
      const choices = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
      if (Array.isArray(choices) && choices.length) {
        return choices.map(String);
      }
    }
  } catch (err) {
    console.error('[ComfyUI] Failed to fetch checkpoints list:', err);
  }
  const configured = process.env.COMFYUI_CKPT_NAME?.trim();
  if (configured) return [configured];
  return [];
}

function buildDefaultComfyWorkflow(
  checkpoint: string,
  prompt: string,
  negativePrompt: string,
  width: number,
  height: number,
  seed: number | string,
): ComfyWorkflow {
  const steps = Math.max(4, Math.min(100, Number(process.env.COMFYUI_STEPS) || 24));
  const cfg = Math.max(1, Math.min(30, Number(process.env.COMFYUI_CFG) || 7));
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] }, _meta: { title: 'STORY_PROMPT' } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: negativePrompt, clip: ['1', 1] }, _meta: { title: 'STORY_NEGATIVE' } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps,
        cfg,
        sampler_name: process.env.COMFYUI_SAMPLER || 'euler',
        scheduler: process.env.COMFYUI_SCHEDULER || 'normal',
        denoise: 1,
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'story-bank/generated', images: ['6', 0] } },
  };
}

function buildDefaultUIWorkflow(
  checkpoint: string,
  prompt: string,
  negativePrompt: string,
  width: number,
  height: number,
  seed: number | string,
): any {
  const steps = Math.max(4, Math.min(100, Number(process.env.COMFYUI_STEPS) || 24));
  const cfg = Math.max(1, Math.min(30, Number(process.env.COMFYUI_CFG) || 7));
  const sampler = process.env.COMFYUI_SAMPLER || 'euler';
  const scheduler = process.env.COMFYUI_SCHEDULER || 'normal';

  return {
    version: 0.4,
    extra: {},
    nodes: [
      {
        id: 1,
        type: 'CheckpointLoaderSimple',
        pos: [20, 150],
        size: [315, 98],
        flags: {},
        order: 0,
        mode: 0,
        outputs: [
          { name: 'MODEL', type: 'MODEL', links: [1], slot_index: 0 },
          { name: 'CLIP', type: 'CLIP', links: [2, 3], slot_index: 1 },
          { name: 'VAE', type: 'VAE', links: [8], slot_index: 2 }
        ],
        properties: { 'Node name for Google Colab': 'CheckpointLoaderSimple' },
        widgets_values: [checkpoint]
      },
      {
        id: 2,
        type: 'CLIPTextEncode',
        pos: [400, 100],
        size: [422, 140],
        flags: {},
        order: 1,
        mode: 0,
        inputs: [{ name: 'clip', type: 'CLIP', link: 2 }],
        outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [4], slot_index: 0 }],
        properties: { 'Node name for Google Colab': 'CLIPTextEncode' },
        widgets_values: [prompt],
        title: 'STORY_PROMPT'
      },
      {
        id: 3,
        type: 'CLIPTextEncode',
        pos: [400, 280],
        size: [422, 140],
        flags: {},
        order: 2,
        mode: 0,
        inputs: [{ name: 'clip', type: 'CLIP', link: 3 }],
        outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [5], slot_index: 0 }],
        properties: { 'Node name for Google Colab': 'CLIPTextEncode' },
        widgets_values: [negativePrompt],
        title: 'STORY_NEGATIVE'
      },
      {
        id: 4,
        type: 'EmptyLatentImage',
        pos: [20, 300],
        size: [315, 106],
        flags: {},
        order: 3,
        mode: 0,
        outputs: [{ name: 'LATENT', type: 'LATENT', links: [6], slot_index: 0 }],
        properties: { 'Node name for Google Colab': 'EmptyLatentImage' },
        widgets_values: [width, height, 1]
      },
      {
        id: 5,
        type: 'KSampler',
        pos: [860, 150],
        size: [315, 262],
        flags: {},
        order: 4,
        mode: 0,
        inputs: [
          { name: 'model', type: 'MODEL', link: 1 },
          { name: 'positive', type: 'CONDITIONING', link: 4 },
          { name: 'negative', type: 'CONDITIONING', link: 5 },
          { name: 'latent_image', type: 'LATENT', link: 6 }
        ],
        outputs: [{ name: 'LATENT', type: 'LATENT', links: [7], slot_index: 0 }],
        properties: { 'Node name for Google Colab': 'KSampler' },
        widgets_values: [
          seed,
          'randomize',
          steps,
          cfg,
          sampler,
          scheduler,
          1.0
        ]
      },
      {
        id: 6,
        type: 'VAEDecode',
        pos: [1210, 200],
        size: [210, 46],
        flags: {},
        order: 5,
        mode: 0,
        inputs: [
          { name: 'samples', type: 'LATENT', link: 7 },
          { name: 'vae', type: 'VAE', link: 8 }
        ],
        outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [9], slot_index: 0 }],
        properties: { 'Node name for Google Colab': 'VAEDecode' }
      },
      {
        id: 7,
        type: 'SaveImage',
        pos: [1450, 200],
        size: [210, 270],
        flags: {},
        order: 6,
        mode: 0,
        inputs: [{ name: 'images', type: 'IMAGE', link: 9 }],
        properties: { 'Node name for Google Colab': 'SaveImage' },
        widgets_values: ['ComfyUI']
      }
    ],
    links: [
      [1, 1, 0, 5, 0, 'MODEL'],
      [2, 1, 1, 2, 0, 'CLIP'],
      [3, 1, 1, 3, 0, 'CLIP'],
      [4, 2, 0, 5, 1, 'CONDITIONING'],
      [5, 3, 0, 5, 2, 'CONDITIONING'],
      [6, 4, 0, 5, 3, 'LATENT'],
      [7, 5, 0, 6, 0, 'LATENT'],
      [8, 1, 2, 6, 1, 'VAE'],
      [9, 6, 0, 7, 0, 'IMAGE']
    ],
    last_node_id: 7,
    last_link_id: 9
  };
}

function findComfyNode(
  workflow: ComfyWorkflow,
  envName: string,
  classTypes: string[],
  titlePattern?: RegExp,
): string | undefined {
  const configured = process.env[envName]?.trim();
  if (configured) {
    if (!workflow[configured]) throw new Error(`${envName} points to missing ComfyUI node ${configured}`);
    return configured;
  }
  const matches = Object.entries(workflow).filter(([, node]) => classTypes.includes(node.class_type));
  if (titlePattern) {
    const titled = matches.find(([, node]) => titlePattern.test(node._meta?.title || ''));
    if (titled) return titled[0];
  }
  return undefined;
}

function setComfyInput(
  workflow: ComfyWorkflow,
  nodeId: string | undefined,
  candidateKeys: string[],
  value: any,
  required: boolean,
  label: string,
): void {
  if (!nodeId) {
    if (required) throw new Error(`Cannot locate the ComfyUI ${label} node; configure its node ID in .env`);
    return;
  }
  const node = workflow[nodeId];
  const key = candidateKeys.find(candidate => Object.prototype.hasOwnProperty.call(node.inputs, candidate));
  if (!key) {
    if (required) throw new Error(`ComfyUI ${label} node ${nodeId} has no supported input (${candidateKeys.join(', ')})`);
    return;
  }
  node.inputs[key] = value;
}

function applyCustomComfyInputs(
  workflow: ComfyWorkflow,
  prompt: string,
  negativePrompt: string,
  width: number,
  height: number,
  seed: number | string,
): ComfyWorkflow {
  const cloned = validateWorkflow(JSON.parse(JSON.stringify(workflow)));
  const promptNode = findComfyNode(cloned, 'COMFYUI_PROMPT_NODE_ID', ['CLIPTextEncode'], /story[_ -]?prompt|positive/i);
  const negativeNode = findComfyNode(cloned, 'COMFYUI_NEGATIVE_NODE_ID', ['CLIPTextEncode'], /negative/i);
  const seedNode = findComfyNode(cloned, 'COMFYUI_SEED_NODE_ID', ['KSampler', 'KSamplerAdvanced', 'RandomNoise', 'Seed'], /seed|sampler/i);
  const checkpointNode = findComfyNode(cloned, 'COMFYUI_CKPT_NODE_ID', ['CheckpointLoaderSimple'], /checkpoint/i);
  const latentNode = findComfyNode(cloned, 'COMFYUI_LATENT_NODE_ID', ['EmptyLatentImage', 'EmptySD3LatentImage'], /latent|size/i);

  setComfyInput(cloned, promptNode, ['text', 'prompt', 'positive'], prompt, true, 'prompt');
  if (negativeNode && negativeNode !== promptNode) {
    setComfyInput(cloned, negativeNode, ['text', 'prompt', 'negative'], negativePrompt, false, 'negative prompt');
  }
  setComfyInput(cloned, seedNode, ['seed', 'noise_seed'], seed, true, 'seed');
  if (process.env.COMFYUI_CKPT_NAME?.trim()) {
    setComfyInput(cloned, checkpointNode, ['ckpt_name', 'checkpoint'], process.env.COMFYUI_CKPT_NAME.trim(), true, 'checkpoint');
  }
  setComfyInput(cloned, latentNode, ['width'], width, false, 'width');
  setComfyInput(cloned, latentNode, ['height'], height, false, 'height');
  return cloned;
}

function comfyErrorMessage(record: any): string {
  const messages = record?.status?.messages;
  if (Array.isArray(messages)) {
    for (const message of [...messages].reverse()) {
      const detail = Array.isArray(message) ? message[1] : message;
      if (detail?.exception_message || detail?.error) {
        return String(detail.exception_message || detail.error).slice(0, 500);
      }
    }
  }
  return 'ComfyUI generation failed; check the ComfyUI console for details';
}

async function waitForComfyImage(promptId: string): Promise<ComfyImageOutput> {
  const timeoutSeconds = Math.max(10, Math.min(900, Number(process.env.COMFYUI_TIMEOUT_SECONDS) || 300));
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const response = await comfyFetch(`/history/${encodeURIComponent(promptId)}`, {}, 10_000);
    const history: any = await response.json();
    const record = history?.[promptId];
    if (record) {
      if (record.status?.status_str === 'error') throw new Error(comfyErrorMessage(record));
      const images: ComfyImageOutput[] = [];
      for (const output of Object.values(record.outputs || {}) as any[]) {
        for (const image of output?.images || []) {
          if (image?.filename) images.push(image);
        }
      }
      if (images.length) return images[0];
      if (record.status?.completed) throw new Error('ComfyUI completed without producing an image');
    }
    await new Promise(resolve => setTimeout(resolve, 1_500));
  }
  throw new Error(`ComfyUI generation timed out after ${timeoutSeconds} seconds`);
}

function safePathSegment(value: unknown, fallback: string): string {
  const safe = String(value ?? '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || fallback;
}

function workflowCheckpoint(workflow: ComfyWorkflow): string {
  const loader = Object.values(workflow).find(node => node.class_type === 'CheckpointLoaderSimple');
  return String(loader?.inputs?.ckpt_name || process.env.COMFYUI_CKPT_NAME || 'custom-workflow');
}

async function persistComfyImage(image: ComfyImageOutput, context: ImageTargetContext): Promise<string> {
  const query = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder || '',
    type: image.type || 'output',
  });
  const response = await comfyFetch(`/view?${query.toString()}`, {}, 30_000);
  const contentType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  const extensions: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
  };
  if (!extensions[contentType]) throw new Error(`ComfyUI returned unsupported content type: ${contentType || 'unknown'}`);
  const maxBytes = Math.max(1, Number(process.env.COMFYUI_MAX_IMAGE_MB) || 30) * 1024 * 1024;
  const declaredSize = Number(response.headers.get('content-length') || 0);
  if (declaredSize > maxBytes) throw new Error('ComfyUI image exceeds the configured size limit');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > maxBytes) throw new Error('ComfyUI returned an empty or oversized image');

  const projectId = safePathSegment(context.projectId, 'unassigned');
  const targetDir = context.targetType === 'shot'
    ? path.join('shots', String(Math.max(0, Number(context.shotIndex) || 0) + 1).padStart(2, '0'))
    : path.join('characters', safePathSegment(context.characterName, 'character'));
  const relativeDir = path.join('projects', projectId, targetDir);
  const imagesDir = path.join(UPLOADS_DIR, relativeDir);
  fs.mkdirSync(imagesDir, { recursive: true });
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const filename = `comfyui-${hash}${extensions[contentType]}`;
  const destination = path.join(imagesDir, filename);
  if (!fs.existsSync(destination)) fs.writeFileSync(destination, buffer);
  return `/uploads/${relativeDir.replace(/\\/g, '/')}/${filename}`;
}

let lastWorkflowFamily: string | null = null;

async function submitComfyTask(task: any) {
  try {
    console.log('[ComfySubmit:Request]', JSON.stringify({ taskId: task.id, shotId: task.targetId, presetId: task.workflowPresetId || null, prompt_id: task.comfyPromptId || task.id, status: task.status, error: null }));
    const preflight = await comfyPermissionPreflight();
    console.log('[ComfyPreflight:Result]', JSON.stringify({ taskId: task.id, shotId: task.targetId, presetId: task.workflowPresetId || null, ...preflight }));
    if (!preflight.online) throw new Error(`ComfyUI 未连接：${preflight.onlineError || preflight.comfyUrl}`);
    if (preflight.multipleProcesses || preflight.dbLocked) {
      const processDetails = preflight.processes.map(item => `PID ${item.processId}: ${item.commandLine || item.name}`).join('; ');
      const lockDetails = preflight.dbLocked ? `comfyui.db: ${preflight.dbLockError || preflight.dbPath}` : '';
      throw new Error(`检测到 8001 已被占用或 comfyui.db 被锁，请关闭重复 ComfyUI 进程后，只启动一个 ComfyUI 实例。${[processDetails, lockDetails].filter(Boolean).join('; ')}`);
    }
    if (!preflight.input.writable || !preflight.output.writable || !preflight.userDefault.writable) {
      const details = [
        !preflight.input.writable ? `input: ${preflight.input.error || 'not writable'}` : '',
        !preflight.output.writable ? `output: ${preflight.output.error || 'not writable'}` : '',
        !preflight.userDefault.writable ? `user/default: ${preflight.userDefault.error || 'not writable'}` : '',
      ].filter(Boolean).join('; ');
      throw new Error(`ComfyUI input/output 无写入权限，请关闭重复 ComfyUI 进程或修复文件夹权限。${details}`);
    }
    let workflow: any;
    if (task.apiWorkflowJson) {
      try {
        workflow = JSON.parse(task.apiWorkflowJson);
      } catch (err) {
        console.warn(`[Worker] Failed to parse apiWorkflowJson for task ${task.id}, rebuilding...`);
      }
    }

    if (!workflow) {
      const seedVal = task.seed ? String(task.seed) : String(Math.floor(Math.random() * 9007199254740991));
      const customWorkflow = loadCustomComfyWorkflow();
      const checkpoint = customWorkflow ? '' : (task.model && task.model !== 'unknown' ? task.model : await getComfyCheckpoint());
      const workflowSnapshot = customWorkflow
        ? applyCustomComfyInputs(customWorkflow, task.prompt, task.negativePrompt, task.width, task.height, seedVal)
        : buildDefaultComfyWorkflow(checkpoint, task.prompt, task.negativePrompt, task.width, task.height, seedVal);

      workflow = workflowSnapshot;
      const apiJson = JSON.stringify(workflowSnapshot);
      const uiJson = JSON.stringify(workflowSnapshot);
      const finalModel = checkpoint || workflowCheckpoint(workflowSnapshot);

      dbSqlite.prepare(`
        UPDATE comfyui_tasks
        SET apiWorkflowJson = ?, uiWorkflowJson = ?, model = ?, seed = ?, updatedAt = ?
        WHERE id = ?
      `).run(apiJson, uiJson, finalModel, String(seedVal), new Date().toISOString(), task.id);
    }

    if (task.workflowFamily && task.workflowFamily !== lastWorkflowFamily) {
      if (lastWorkflowFamily !== null) {
        try {
          console.log(`[Worker] Workflow family changed from ${lastWorkflowFamily} to ${task.workflowFamily}. Checking if ComfyUI supports /free...`);
          const freeRes = await comfyFetch('/free', { method: 'POST' }, 5000);
          if (freeRes.status === 200) {
            console.log(`[Worker] Cleared GPU cache via ComfyUI /free endpoint.`);
          } else {
            console.log(`[Worker] ComfyUI /free returned status ${freeRes.status}. Skipping.`);
          }
        } catch (e: any) {
          console.log(`[Worker] ComfyUI /free check failed or not supported: ${e.message}. Skipping.`);
        }
      }
      lastWorkflowFamily = task.workflowFamily;
    }

    if (task.workflowPresetId) {
      const manifestPath = resolvePresetManifestPath(task.workflowPresetId);
      if (manifestPath && fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const mappings = manifest.nodeMappings || {};

        console.log('[CharacterConsistency:WorkerMapping]', JSON.stringify({
          taskId: task.id,
          targetId: task.targetId,
          shotIndex: task.shotIndex,
          workflowPresetId: task.workflowPresetId,
          workflowFamily: task.workflowFamily,
          model: task.model,
          sourceImageUrl: task.sourceImageUrl || null,
          loadImageNodeId: mappings.loadImageNodeId || null,
          loadImageInputKey: mappings.loadImageInputKey || null,
          mappingNodeExists: !!workflow?.[mappings.loadImageNodeId],
        }));

        if (mappings.loadImageNodeId && task.sourceImageUrl) {
          const matchedCharacter = task.targetType === 'shot'
            ? shotCharacters(String(task.projectId), task.shotIndex, task.prompt)[0]
            : null;
          const uploadContext = {
            taskId: task.id,
            shotId: task.targetId,
            characterId: matchedCharacter?.id || null,
            characterReferenceImageUrl: task.sourceImageUrl,
            characterReferenceTaskId: task.characterReferenceTaskId || task.sourceTaskId || null,
          };
          console.log('[ReferenceUpload:Start]', JSON.stringify(uploadContext));
          let referenceFile: ReferenceImageFile;
          try {
            referenceFile = resolveReferenceImageFile(task.sourceImageUrl, true);
          } catch (error: any) {
            console.error('[ReferenceUpload:Failed]', JSON.stringify({ ...uploadContext, status: null, responseText: null, error: error.message }));
            throw error;
          }
          const localFilePath = referenceFile.resolvedPath;
          console.log('[ReferenceUpload:Resolve]', JSON.stringify({ ...uploadContext, resolvedPath: localFilePath, exists: referenceFile.exists }));
          console.log('[CharacterConsistency:ReferenceFile]', JSON.stringify({
            taskId: task.id,
            sourceImageUrl: task.sourceImageUrl,
            localFilePath,
            fileExists: referenceFile.exists,
          }));
          console.log('[ReferenceUpload:Read]', JSON.stringify({ ...uploadContext, resolvedPath: localFilePath, exists: referenceFile.exists, size: referenceFile.size, mime: referenceFile.mime, ext: referenceFile.ext, canRead: referenceFile.canRead }));
          if (!referenceFile.exists) {
            const error = `Reference image file not found: ${localFilePath}`;
            console.error('[ReferenceUpload:Failed]', JSON.stringify({ ...uploadContext, resolvedPath: localFilePath, exists: false, status: null, responseText: null, error }));
            throw new Error(error);
          }
          if (!referenceFile.canRead || !referenceFile.buffer?.length) {
            const error = `Reference image invalid or empty: ${localFilePath}`;
            console.error('[ReferenceUpload:Failed]', JSON.stringify({ ...uploadContext, resolvedPath: localFilePath, exists: true, size: referenceFile.size, mime: referenceFile.mime, status: null, responseText: null, error }));
            throw new Error(error);
          }

          const safeCharacterId = safePathSegment(matchedCharacter?.id, 'character');
          const safeFilename = `reference_${safePathSegment(task.id, 'task')}_${safeCharacterId}${referenceFile.ext}`;
          const formData = new FormData();
          const blob = new Blob([referenceFile.buffer], { type: referenceFile.mime });
          formData.append('image', blob, safeFilename);
          formData.append('type', 'input');
          formData.append('overwrite', 'true');

          const uploadUrl = `${comfyBaseUrl()}/upload/image`;
          console.log('[ReferenceUpload:ComfyRequest]', JSON.stringify({ ...uploadContext, resolvedPath: localFilePath, size: referenceFile.size, mime: referenceFile.mime, ext: referenceFile.ext, uploadUrl, multipartField: 'image', fields: { type: 'input', overwrite: 'true' }, filename: safeFilename }));
          let uploadRes: Response;
          let responseText = '';
          try {
            uploadRes = await fetch(uploadUrl, { method: 'POST', body: formData });
            responseText = await uploadRes.text();
          } catch (error: any) {
            console.error('[ReferenceUpload:Failed]', JSON.stringify({ ...uploadContext, uploadUrl, status: null, responseText: null, error: error.message }));
            throw new Error(`ComfyUI upload/image request failed: ${error.message}`);
          }
          console.log('[ReferenceUpload:ComfyResponse]', JSON.stringify({ ...uploadContext, uploadUrl, status: uploadRes.status, responseText }));
          if (!uploadRes.ok) {
            const detail = responseText || uploadRes.statusText || 'empty response';
            console.error('[ReferenceUpload:Failed]', JSON.stringify({ ...uploadContext, uploadUrl, status: uploadRes.status, responseText: detail, error: 'ComfyUI upload/image failed' }));
            throw new Error(`ComfyUI upload/image ${uploadRes.status}: ${detail}`);
          }

          let resJson: any;
          try {
            resJson = JSON.parse(responseText);
          } catch {
            throw new Error(`ComfyUI upload/image returned invalid JSON: ${responseText || 'empty response'}`);
          }
          if (!resJson?.name) throw new Error(`ComfyUI upload/image response missing name: ${responseText}`);
          const comfyFilename = [resJson.subfolder, resJson.name].filter(Boolean).join('/').replace(/\\/g, '/');
          const loadNode = workflow[mappings.loadImageNodeId];
          if (loadNode && loadNode.inputs) {
            const previousValue = loadNode.inputs[mappings.loadImageInputKey];
            loadNode.inputs[mappings.loadImageInputKey] = comfyFilename;
            console.log('[CharacterConsistency:WorkflowInjected]', JSON.stringify({
              taskId: task.id,
              nodeId: mappings.loadImageNodeId,
              inputKey: mappings.loadImageInputKey,
              previousValue: previousValue ?? null,
              injectedValue: comfyFilename,
              uploadedImage: { name: resJson.name, subfolder: resJson.subfolder || '', type: resJson.type || 'input' },
              verified: loadNode.inputs[mappings.loadImageInputKey] === comfyFilename,
            }));
            dbSqlite.prepare(`UPDATE comfyui_tasks SET apiWorkflowJson = ?, updatedAt = ? WHERE id = ?`)
              .run(JSON.stringify(workflow), new Date().toISOString(), task.id);
          }
        } else {
          console.warn('[CharacterConsistency:ReferenceNotInjected]', JSON.stringify({
            taskId: task.id,
            workflowPresetId: task.workflowPresetId,
            hasLoadImageMapping: !!mappings.loadImageNodeId,
            sourceImageUrl: task.sourceImageUrl || null,
          }));
        }
      }
    }

    const clientId = crypto.randomUUID();
    const uiWorkflow = exportedUiWorkflow(task);

    console.log(`[Worker] Submitting workflow to ComfyUI for task ${task.id} with prompt: "${task.prompt.slice(0, 100)}..."`);

    const response = await comfyFetch('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: workflow,
        client_id: clientId,
        prompt_id: task.id,
        extra_data: {
          extra_pnginfo: {
            workflow: uiWorkflow,
          },
        },
      }),
    });

    const result: any = await response.json();
    console.log('[ComfySubmit:Response]', JSON.stringify({ taskId: task.id, shotId: task.targetId, presetId: task.workflowPresetId || null, prompt_id: result?.prompt_id || null, status: response.status, error: result?.error || result?.node_errors || null }));
    if (!result?.prompt_id) {
      const detail = result?.error || result?.node_errors;
      throw new Error(`ComfyUI did not accept the workflow: ${JSON.stringify(detail).slice(0, 500)}`);
    }

    dbSqlite.prepare(`UPDATE comfyui_tasks SET comfyPromptId = ?, stateDetail = 'queued', queuePosition = NULL, updatedAt = ? WHERE id = ? AND status = 'processing'`).run(String(result.prompt_id), new Date().toISOString(), task.id);
    console.log('[TaskState:Update]', JSON.stringify({ taskId: task.id, shotId: task.targetId, presetId: task.workflowPresetId || null, prompt_id: result.prompt_id, status: 'processing', error: null }));

    console.log(`[Worker] Task ${task.id} accepted by ComfyUI successfully.`);
  } catch (err: any) {
    console.error(`[Worker] Failed to submit task ${task.id} to ComfyUI:`, err.message);
    {
      let finalError = (err.code === 'ECONNREFUSED' || err.message.includes('fetch'))
        ? `ComfyUI connection failed: ${err.message}`
        : (err.message || 'Unknown error');
      if (
        finalError.toLowerCase().includes('out of memory') ||
        finalError.toLowerCase().includes('cuda out of memory') ||
        finalError.toLowerCase().includes('oom')
      ) {
        finalError = 'CUDA out of memory. Please restart ComfyUI with --lowvram --reserve-vram 1.';
      }
      dbSqlite.prepare(`
        UPDATE comfyui_tasks SET status = 'failed', error = ?, stateDetail = 'failed', completedAt = ?, updatedAt = ? WHERE id = ?
      `).run(finalError, new Date().toISOString(), new Date().toISOString(), task.id);
      console.error('[TaskState:Failed]', JSON.stringify({ taskId: task.id, shotId: task.targetId, presetId: task.workflowPresetId || null, prompt_id: task.comfyPromptId || task.id, status: 'failed', error: finalError }));
    }
  }
}

async function generateWithComfyUI(
  prompt: string,
  negativePrompt: string,
  width: number,
  height: number,
  requestedSeed?: unknown,
  context: ImageTargetContext = {},
): Promise<{ url: string; seed: number; promptId: string; model: string }> {
  const parsedSeed = Number(requestedSeed);
  const seed = Number.isSafeInteger(parsedSeed) && parsedSeed >= 0
    ? parsedSeed
    : Number(BigInt(`0x${crypto.randomBytes(8).toString('hex')}`) % 9_007_199_254_740_991n);
  const customWorkflow = loadCustomComfyWorkflow();
  const checkpoint = customWorkflow ? undefined : await getComfyCheckpoint();
  const workflow = customWorkflow
    ? applyCustomComfyInputs(customWorkflow, prompt, negativePrompt, width, height, seed)
    : buildDefaultComfyWorkflow(checkpoint!, prompt, negativePrompt, width, height, seed);
  const model = checkpoint || workflowCheckpoint(workflow);
  const clientId = crypto.randomUUID();
  const response = await comfyFetch('/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  const result: any = await response.json();
  if (!result?.prompt_id) {
    const detail = result?.error || result?.node_errors;
    throw new Error(`ComfyUI did not accept the workflow${detail ? `: ${JSON.stringify(detail).slice(0, 500)}` : ''}`);
  }
  const image = await waitForComfyImage(result.prompt_id);
  return { url: await persistComfyImage(image, context), seed, promptId: result.prompt_id, model };
}

app.get('/api/comfyui/status', async (_req, res) => {
  const baseUrl = comfyBaseUrl();
  try {
    await comfyFetch('/system_stats', {}, 5_000);
    const checkpoint = await getComfyCheckpoint();
    return res.json({ available: true, baseUrl, checkpoint });
  } catch (error: any) {
    return res.json({
      available: false,
      baseUrl,
      error: error?.message || 'Unable to connect to ComfyUI',
    });
  }
});

// --- ComfyUI Queue Worker and Tasks Endpoints ---

async function checkComfyTaskState(promptId: string): Promise<
  | { status: 'succeeded'; image: any }
  | { status: 'failed'; error: string }
  | { status: 'processing'; queuePosition: number; phase: 'queued' | 'running' }
  | { status: 'network_error' }
  | { status: 'missing' }
> {
  try {
    // 1. Check history
    const historyRes = await comfyFetch(`/history/${promptId}`, {}, 5_000);
    const history = await historyRes.json();
    const record = history?.[promptId];
    console.log('[ComfyHistory:Result]', JSON.stringify({ taskId: promptId, shotId: null, presetId: null, prompt_id: promptId, status: record?.status?.status_str || (record ? 'found' : 'missing'), error: record?.status?.status_str === 'error' ? comfyErrorMessage(record) : null }));
    if (record) {
      if (record.status?.status_str === 'error') {
        const errMsg = comfyErrorMessage(record);
        if (
          errMsg.toLowerCase().includes('out of memory') ||
          errMsg.toLowerCase().includes('cuda out of memory') ||
          errMsg.toLowerCase().includes('oom')
        ) {
          return { status: 'failed', error: 'CUDA out of memory. Please restart ComfyUI with --lowvram --reserve-vram 1.' };
        }
        return { status: 'failed', error: errMsg };
      }

      // Get target outputNodeId from task
      const taskRow = dbSqlite.prepare("SELECT outputNodeId FROM comfyui_tasks WHERE id = ?").get(promptId) as { outputNodeId?: string } | undefined;
      const targetNodeId = taskRow?.outputNodeId;

      const images: any[] = [];
      if (targetNodeId) {
        const nodeOutput = record.outputs?.[targetNodeId];
        if (nodeOutput && Array.isArray(nodeOutput.images)) {
          for (const image of nodeOutput.images) {
            if (image?.filename) images.push(image);
          }
        }
      } else {
        // Fallback for backward compatibility
        for (const output of Object.values(record.outputs || {}) as any[]) {
          for (const image of output?.images || []) {
            if (image?.filename) images.push(image);
          }
        }
      }

      if (images.length) {
        return { status: 'succeeded', image: images[0] };
      }
      if (record.status?.completed) {
        return { status: 'failed', error: 'ComfyUI completed without producing an image' };
      }
    }

    // 2. Check queue
    const queueRes = await comfyFetch('/queue', {}, 5_000);
    const queue = await queueRes.json();

    const running = queue.queue_running || [];
    const pending = queue.queue_pending || [];

    const inRunning = running.some((item: any) => item[1] === promptId);
    const pendingIndex = pending.findIndex((item: any) => item[1] === promptId);
    const inPending = pendingIndex >= 0;
    console.log('[ComfyQueue:Status]', JSON.stringify({ taskId: promptId, shotId: null, presetId: null, prompt_id: promptId, status: inRunning ? 'running' : inPending ? 'queued' : 'missing', queuePosition: inRunning ? 0 : inPending ? pendingIndex + 1 : null, error: null }));

    if (inRunning) return { status: 'processing', queuePosition: 0, phase: 'running' };
    if (inPending) return { status: 'processing', queuePosition: pendingIndex + 1, phase: 'queued' };

    // 3. Not in history and not in queue
    return { status: 'failed', error: `ComfyUI prompt '${promptId}' is missing from both queue and history` };
  } catch (err: any) {
    const isNetwork = err.code === 'ECONNREFUSED' || err.message.includes('fetch');
    if (isNetwork) {
      return { status: 'network_error' };
    }
    let finalError = err.message || 'Unknown error';
    if (
      finalError.toLowerCase().includes('out of memory') ||
      finalError.toLowerCase().includes('cuda out of memory') ||
      finalError.toLowerCase().includes('oom')
    ) {
      finalError = 'CUDA out of memory. Please restart ComfyUI with --lowvram --reserve-vram 1.';
    }
    return { status: 'failed', error: finalError };
  }
}

async function pollActiveTasks() {
  const timeoutCutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  const timedOutTasks = dbSqlite.prepare(`SELECT id,targetId,workflowPresetId,comfyPromptId,status FROM comfyui_tasks WHERE status IN ('pending','processing') AND createdAt < ?`).all(timeoutCutoff) as any[];
  for (const timedOut of timedOutTasks) {
    const timeoutError = 'Task timed out after 10 minutes';
    dbSqlite.prepare(`UPDATE comfyui_tasks SET status='failed', stateDetail='timeout', error=?, completedAt=?, updatedAt=? WHERE id=? AND status IN ('pending','processing')`).run(timeoutError, new Date().toISOString(), new Date().toISOString(), timedOut.id);
    console.error('[TaskState:Timeout]', JSON.stringify({ taskId: timedOut.id, shotId: timedOut.targetId, presetId: timedOut.workflowPresetId || null, prompt_id: timedOut.comfyPromptId || null, status: 'timeout', error: timeoutError }));
  }
  const activeTasks = dbSqlite.prepare("SELECT * FROM comfyui_tasks WHERE status = 'processing'").all() as any[];
  for (const task of activeTasks) {
    try {
      const promptId = task.comfyPromptId || task.id;
      const state = await checkComfyTaskState(promptId);
      if (state.status === 'succeeded') {
        console.log(`[Worker] Task ${task.id} succeeded. Fetching image...`);
        const image = state.image;
        const imageUrl = await persistComfyImage(image, {
          projectId: task.projectId,
          targetType: task.targetType,
          shotIndex: task.shotIndex,
          characterName: task.characterName,
        });

        const generation = {
          provider: 'comfyui',
          status: 'succeeded',
          prompt: task.prompt,
          negativePrompt: task.negativePrompt,
          seed: task.seed,
          model: task.model,
          width: task.width,
          height: task.height,
          promptId: task.id,
          workflowPresetId: task.workflowPresetId || 'sdxl_legacy',
          workflowFamily: task.workflowFamily || 'sdxl',
          projectId: task.projectId,
          targetType: task.targetType,
          ...(task.shotIndex !== null ? { shotIndex: task.shotIndex } : {}),
          ...(task.characterName ? { characterName: task.characterName } : {}),
          createdAt: task.createdAt,
        };

        // Mutate DB and complete task in a single write queue block (atomic update of script + task status)
        await mutateDb(async (db) => {
          // Check task status first inside transaction to verify it wasn't cancelled/superseded!
          const currentTask = dbSqlite.prepare("SELECT status FROM comfyui_tasks WHERE id = ?").get(task.id) as { status: string } | undefined;
          if (!currentTask || currentTask.status !== 'processing') {
            console.log(`[Worker] Task ${task.id} status was changed to ${currentTask?.status || 'deleted'} before write back. Skipping.`);
            return;
          }

          // Update script
          const scriptIndex = db.generated_scripts.findIndex((s: any) => String(s.id) === String(task.projectId));
          if (scriptIndex !== -1) {
            const script = db.generated_scripts[scriptIndex];
            if (task.targetType === 'shot') {
              const shot = script.newShots?.find((s: any) => String(s.id) === String(task.targetId));
              if (shot) {
                shot.imageUrl = imageUrl;
                shot.generatedImageUrl = imageUrl;
                shot.imageGeneration = generation;
                shot.imageGenerations = [...(shot.imageGenerations || []), generation];
              }
            } else if (task.targetType === 'character') {
              const char = script.newCharacters?.find((c: any) => c.id === task.targetId);
              if (char) {
                if (task.viewType && task.viewType !== 'avatar') {
                  if (!char.views) char.views = {};
                  char.views[task.viewType] = imageUrl;
                  if (!char.viewGenerations) char.viewGenerations = {};
                  char.viewGenerations[task.viewType] = {
                    presetId: task.workflowPresetId || 'sdxl_legacy',
                    model: task.model,
                    imageUrl,
                    taskId: task.id,
                  };
                } else {
                  char.avatarUrl = imageUrl;
                  char.avatarImageUrl = imageUrl;
                  char.sourceTaskId = task.id;
                  char.hasReference = true;
                  char.avatarGeneration = {
                    presetId: task.workflowPresetId || 'sdxl_legacy',
                    model: task.model,
                    imageUrl,
                    taskId: task.id,
                  };
                }
                char.imageGeneration = generation;
                char.imageGenerations = [...(char.imageGenerations || []), generation];
              }
            }
            db.generated_scripts[scriptIndex] = script;
          }

          // Complete task status to succeeded
          dbSqlite.prepare(`
            UPDATE comfyui_tasks
            SET status = 'succeeded', imageUrl = ?, completedAt = ?, updatedAt = ?
            WHERE id = ? AND status = 'processing'
          `).run(imageUrl, new Date().toISOString(), new Date().toISOString(), task.id);
          dbSqlite.prepare(`UPDATE comfyui_tasks SET stateDetail='succeeded', queuePosition=NULL WHERE id=?`).run(task.id);
          console.log('[TaskState:Update]', JSON.stringify({ taskId: task.id, shotId: task.targetId, presetId: task.workflowPresetId || null, prompt_id: promptId, status: 'succeeded', outputImageUrl: imageUrl, error: null }));
          dbSqlite.prepare(`UPDATE comfyui_shot_batch_items SET finalStatus = 'success', updatedAt = ? WHERE taskId = ?`).run(new Date().toISOString(), task.id);
        });

      } else if (state.status === 'processing') {
        dbSqlite.prepare(`UPDATE comfyui_tasks SET stateDetail=?, queuePosition=?, updatedAt=? WHERE id=? AND status='processing'`).run(state.phase, state.queuePosition, new Date().toISOString(), task.id);
        console.log('[TaskState:Update]', JSON.stringify({ taskId: task.id, shotId: task.targetId, presetId: task.workflowPresetId || null, prompt_id: promptId, status: state.phase, queuePosition: state.queuePosition, error: null }));
        // Reset missing counters if found active in ComfyUI queue
        if (task.missingSince || task.recoveryCheckCount > 0) {
          dbSqlite.prepare(`
            UPDATE comfyui_tasks SET missingSince = NULL, recoveryCheckCount = 0, updatedAt = ? WHERE id = ?
          `).run(new Date().toISOString(), task.id);
        }
      } else if (state.status === 'network_error') {
        const error = 'ComfyUI disconnected while checking task state';
        dbSqlite.prepare(`UPDATE comfyui_tasks SET status='failed', stateDetail='failed', error=?, completedAt=?, updatedAt=? WHERE id=? AND status='processing'`).run(error, new Date().toISOString(), new Date().toISOString(), task.id);
        console.error('[TaskState:Failed]', JSON.stringify({ taskId: task.id, shotId: task.targetId, presetId: task.workflowPresetId || null, prompt_id: promptId, status: 'failed', error }));
      } else if (state.status === 'missing') {
        // Increment missing counter
        let missingSince = task.missingSince;
        if (!missingSince) {
          missingSince = new Date().toISOString();
        }
        const count = (task.recoveryCheckCount || 0) + 1;

        dbSqlite.prepare(`
          UPDATE comfyui_tasks
          SET missingSince = ?, recoveryCheckCount = ?, updatedAt = ?
          WHERE id = ?
        `).run(missingSince, count, new Date().toISOString(), task.id);

        const elapsed = Date.now() - new Date(missingSince).getTime();
        if (count >= 5 && elapsed >= 60_000) {
          console.log(`[Worker] Task ${task.id} is confirmed lost after ${count} checks and ${elapsed}ms. Failing task.`);
          dbSqlite.prepare(`
            UPDATE comfyui_tasks
            SET status = 'failed', stateDetail='failed', missingSince = NULL, recoveryCheckCount = 0, error = 'ComfyUI task lost: missing from queue and history', completedAt=?, updatedAt = ?
            WHERE id = ? AND status = 'processing'
          `).run(new Date().toISOString(), new Date().toISOString(), task.id);
        }
      } else if (state.status === 'failed') {
        console.log(`[Worker] Task ${task.id} failed in ComfyUI: ${state.error}`);
        dbSqlite.prepare(`
          UPDATE comfyui_tasks
          SET status = 'failed', error = ?, completedAt = ?, updatedAt = ?
          WHERE id = ? AND status = 'processing'
        `).run(state.error, new Date().toISOString(), new Date().toISOString(), task.id);
        dbSqlite.prepare(`UPDATE comfyui_tasks SET stateDetail='failed', queuePosition=NULL WHERE id=?`).run(task.id);
        console.error('[TaskState:Failed]', JSON.stringify({ taskId: task.id, shotId: task.targetId, presetId: task.workflowPresetId || null, prompt_id: promptId, status: 'failed', error: state.error }));
        dbSqlite.prepare(`UPDATE comfyui_shot_batch_items SET finalStatus = 'failed', error = ?, updatedAt = ? WHERE taskId = ?`).run(state.error, new Date().toISOString(), task.id);
      }
    } catch (err: any) {
      console.error(`[Worker] Error checking state for task ${task.id}:`, err);
    }
  }
  dbSqlite.prepare(`
    UPDATE comfyui_shot_batches SET status = CASE
      WHEN EXISTS (SELECT 1 FROM comfyui_shot_batch_items i WHERE i.batchId = comfyui_shot_batches.id AND i.finalStatus IN ('pending','processing')) THEN 'running'
      ELSE 'completed' END, updatedAt = ? WHERE status = 'running'
  `).run(new Date().toISOString());
}



let workerInterval: NodeJS.Timeout | null = null;
let isProcessingQueue = false;

function startComfyWorker() {
  if (workerInterval) return;
  console.log('[Worker] Starting ComfyUI queue worker...');

  workerInterval = setInterval(async () => {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    try {
      // 1. Process active tasks
      await pollActiveTasks();

      // 2. Concurrency limit 1 check
      const activeCountRow = dbSqlite.prepare("SELECT COUNT(*) as count FROM comfyui_tasks WHERE status = 'processing'").get() as any;
      const activeCount = activeCountRow ? activeCountRow.count : 0;

      if (activeCount < 1) {
        const nextTask = dbSqlite.prepare(`
          SELECT * FROM comfyui_tasks
          WHERE status = 'pending'
          ORDER BY createdAt ASC
          LIMIT 1
        `).get() as any;

        if (nextTask) {
          const updateResult = dbSqlite.prepare(`
            UPDATE comfyui_tasks
            SET status = 'processing', stateDetail = 'submitting', submittedAt = ?, updatedAt = ?
            WHERE id = ? AND status = 'pending'
          `).run(new Date().toISOString(), new Date().toISOString(), nextTask.id);

          if (updateResult.changes === 1) {
            console.log('[TaskState:Update]', JSON.stringify({ taskId: nextTask.id, shotId: nextTask.targetId, presetId: nextTask.workflowPresetId || null, prompt_id: null, status: 'submitting', error: null }));
            console.log(`[Worker] Atomically locked task ${nextTask.id} for execution.`);
            await submitComfyTask(nextTask);
          }
        }
      }
    } catch (err) {
      console.error('[Worker Error]', err);
    } finally {
      isProcessingQueue = false;
    }
  }, 1500);
}

// --- End of ComfyUI Queue Worker ---

// --- ComfyUI Runtime Manager ---
import { spawn } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(require('child_process').exec);

async function isComfyUiAccessible(): Promise<boolean> {
  try {
    const response = await comfyFetch('/', { method: 'GET' }, 2000);
    return response.ok;
  } catch {
    return false;
  }
}

class ComfyUiRuntimeManager {
  private childProcess: any = null;
  private pid: number | null = null;
  private state: 'stopped' | 'starting' | 'running' | 'stopping' | 'external' | 'error' = 'stopped';
  private lastError: string | null = null;
  private stderrBuffer: string[] = [];
  private pollingTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.startStatePolling();
    // Autostart ComfyUI if configured
    if (process.env.COMFYUI_AUTOSTART === 'true' && process.env.COMFYUI_MANAGED_LAUNCH_ENABLED === 'true') {
      console.log('[ComfyUI Runtime] Autostart enabled, starting ComfyUI...');
      this.start().catch(err => {
        console.error('[ComfyUI Runtime] Autostart failed:', err);
      });
    }
  }

  private startStatePolling() {
    this.pollingTimer = setInterval(async () => {
      await this.syncState();
    }, 2000);
  }

  public async syncState(): Promise<void> {
    if (this.state === 'starting' || this.state === 'stopping') {
      return;
    }

    const accessible = await isComfyUiAccessible();
    if (accessible) {
      if (this.childProcess && this.pid) {
        this.state = 'running';
        this.lastError = null;
      } else {
        this.state = 'external';
        this.pid = null;
        this.childProcess = null;
        this.lastError = null;
      }
    } else {
      if (this.state === 'running' || this.state === 'external') {
        this.state = 'stopped';
        this.pid = null;
        this.childProcess = null;
      }
    }
  }

  public getState() {
    return this.state;
  }

  public getPid() {
    return this.pid;
  }

  public getLastError() {
    return this.lastError;
  }

  public isManaged() {
    return !!this.childProcess;
  }

  public async start(): Promise<void> {
    if (process.env.COMFYUI_MANAGED_LAUNCH_ENABLED !== 'true') {
      throw new Error('ComfyUI managed launch is not enabled in environment config.');
    }

    const alreadyAccessible = await isComfyUiAccessible();
    if (alreadyAccessible) {
      if (this.childProcess && this.pid) {
        this.state = 'running';
        return;
      } else {
        this.state = 'external';
        throw new Error('ComfyUI is already running externally.');
      }
    }

    if (this.state === 'starting') {
      return;
    }

    this.state = 'starting';
    this.lastError = null;
    this.stderrBuffer = [];

    const executable = process.env.COMFYUI_EXECUTABLE;
    const workDir = process.env.COMFYUI_WORKDIR;
    const argsJson = process.env.COMFYUI_ARGS_JSON || '[]';

    if (!executable) {
      this.state = 'error';
      this.lastError = 'COMFYUI_EXECUTABLE environment variable is not configured.';
      throw new Error(this.lastError);
    }

    let args: string[] = [];
    try {
      args = JSON.parse(argsJson);
      if (!Array.isArray(args)) {
        throw new Error('COMFYUI_ARGS_JSON is not a JSON array.');
      }
    } catch (e: any) {
      this.state = 'error';
      this.lastError = `Failed to parse COMFYUI_ARGS_JSON: ${e.message}`;
      throw new Error(this.lastError);
    }

    console.log(`[ComfyUI Runtime] Spawning process: "${executable}" with args: ${JSON.stringify(args)} in dir: "${workDir}"`);

    try {
      const spawnEnv = { ...process.env };
      // Ensure git is available for ComfyUI Manager (gitpython dependency)
      const gitDir = 'C:\\Program Files\\Git\\cmd';
      if (spawnEnv.PATH && !spawnEnv.PATH.includes(gitDir)) {
        spawnEnv.PATH = `${spawnEnv.PATH};${gitDir}`;
      }
      // Force UTF-8 encoding to avoid 'charmap' codec errors on Windows
      spawnEnv.PYTHONUTF8 = '1';
      this.childProcess = spawn(executable, args, {
        cwd: workDir || undefined,
        shell: false,
        env: spawnEnv
      });

      this.pid = this.childProcess.pid || null;

      this.childProcess.stderr?.on('data', (data: any) => {
        const chunk = data.toString();
        this.stderrBuffer.push(chunk);
        if (this.stderrBuffer.length > 20) {
          this.stderrBuffer.shift();
        }
      });

      this.childProcess.on('error', (err: any) => {
        console.error('[ComfyUI Process Error]:', err);
        this.state = 'error';
        this.lastError = `Process spawn error: ${err.message}`;
        this.pid = null;
        this.childProcess = null;
      });

      this.childProcess.on('exit', (code: any, signal: any) => {
        console.log(`[ComfyUI Process Exit] Code: ${code}, Signal: ${signal}`);
        if (this.state === 'starting' || this.state === 'running') {
          this.state = 'error';
          const tail = this.stderrBuffer.join('\n').trim();
          this.lastError = `ComfyUI process exited with code ${code}.\nStderr:\n${tail}`.substring(0, 1000);
        } else if (this.state === 'stopping') {
          this.state = 'stopped';
        }
        this.pid = null;
        this.childProcess = null;
      });

      const startTime = Date.now();
      const timeoutMs = Number(process.env.COMFYUI_START_TIMEOUT_MS) || 120000;

      const poll = async () => {
        if (this.state !== 'starting' || !this.childProcess) return;

        const ok = await isComfyUiAccessible();
        if (ok) {
          this.state = 'running';
          this.lastError = null;
          console.log('[ComfyUI Runtime] ComfyUI is running and healthy.');
        } else if (Date.now() - startTime > timeoutMs) {
          console.error('[ComfyUI Runtime] Start timeout exceeded.');
          this.state = 'error';
          this.lastError = `Startup timed out after ${timeoutMs}ms.`;
          this.stop().catch(() => {});
        } else {
          setTimeout(poll, 1000);
        }
      };

      setTimeout(poll, 1000);

    } catch (err: any) {
      this.state = 'error';
      this.lastError = `Spawn failed: ${err.message}`;
      this.pid = null;
      this.childProcess = null;
      throw err;
    }
  }

  public async stop(): Promise<void> {
    if (!this.childProcess || !this.pid) {
      throw new Error('No managed ComfyUI process to stop.');
    }

    this.state = 'stopping';
    const targetPid = this.pid;
    const proc = this.childProcess;

    console.log(`[ComfyUI Runtime] Stopping ComfyUI process (PID: ${targetPid})`);

    try {
      proc.kill('SIGTERM');
    } catch {}

    let stopped = false;
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const ok = await isComfyUiAccessible();
      if (!ok) {
        stopped = true;
        break;
      }
    }

    if (!stopped) {
      console.log(`[ComfyUI Runtime] SIGTERM failed, force killing process tree for PID: ${targetPid}`);
      if (process.platform === 'win32') {
        try {
          await execAsync(`taskkill /F /T /PID ${targetPid}`);
        } catch (e: any) {
          console.error(`[ComfyUI Runtime] taskkill failed: ${e.message}`);
        }
      } else {
        try {
          proc.kill('SIGKILL');
        } catch {}
      }
    }

    const finalCheck = await isComfyUiAccessible();
    if (finalCheck) {
      this.state = 'error';
      this.lastError = 'Failed to stop ComfyUI process (port still active).';
      throw new Error(this.lastError);
    } else {
      this.state = 'stopped';
      this.pid = null;
      this.childProcess = null;
      this.lastError = null;
    }
  }

  public toJSON() {
    return {
      state: this.state,
      connected: this.state === 'running' || this.state === 'external',
      managed: !!this.childProcess,
      pid: this.pid,
      url: comfyBaseUrl(),
      lastError: this.lastError
    };
  }
}

const comfyUiRuntime = new ComfyUiRuntimeManager();

function requireLocalhost(req: any, res: any, next: any) {
  const remoteAddress = req.socket.remoteAddress;
  const isLocal =
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1';

  if (!isLocal) {
    console.warn(`[Security] Blocked non-localhost request to managed runtime API from ${remoteAddress}`);
    return res.status(403).json({ error: 'Forbidden: Access allowed only from localhost.' });
  }
  next();
}

// Runtime API endpoints
app.get('/api/comfyui/runtime', async (req, res) => {
  await comfyUiRuntime.syncState();
  res.json(comfyUiRuntime.toJSON());
});

app.get('/api/comfyui/reference-diagnostic', requireLocalhost, (req, res) => {
  try {
    const characterId = String(req.query.characterId || '').trim();
    let imageUrl = String(req.query.imageUrl || '').trim();
    let character: any = null;
    if (!imageUrl && characterId) {
      for (const script of readDb().generated_scripts || []) {
        character = (script.newCharacters || []).find((item: any) => String(item.id) === characterId);
        if (character) {
          imageUrl = String(character.avatarImageUrl || character.avatarUrl || '');
          break;
        }
      }
    }
    if (!imageUrl) return res.status(400).json({ error: 'characterId has no Avatar, or imageUrl is required' });
    const result = resolveReferenceImageFile(imageUrl, true);
    res.json({
      characterId: characterId || character?.id || null,
      imageUrl,
      resolvedPath: result.resolvedPath,
      exists: result.exists,
      size: result.size,
      mime: result.mime,
      ext: result.ext,
      canRead: result.canRead,
      validForComfyUpload: result.exists && result.canRead && result.size > 0,
    });
  } catch (error: any) {
    res.status(422).json({ error: error.message });
  }
});

app.post('/api/comfyui/runtime/start', requireLocalhost, async (req, res) => {
  try {
    const stateBefore = comfyUiRuntime.getState();
    if (stateBefore === 'running' || stateBefore === 'external') {
      return res.json(comfyUiRuntime.toJSON());
    }

    comfyUiRuntime.start().catch(err => {
      console.error('[ComfyUI Runtime] Async start error:', err);
    });

    res.status(202).json({
      state: 'starting',
      connected: false,
      managed: true,
      pid: comfyUiRuntime.getPid(),
      url: comfyBaseUrl(),
      lastError: null
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/comfyui/runtime/stop', requireLocalhost, async (req, res) => {
  try {
    if (!comfyUiRuntime.isManaged()) {
      return res.status(400).json({ error: 'Cannot stop ComfyUI: it was not started by this application (external).' });
    }
    await comfyUiRuntime.stop();
    res.json(comfyUiRuntime.toJSON());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


// ComfyUI Tasks endpoints
const DEFAULT_PARAMETER_NODE_IDS = Object.freeze({
  positivePrompt: '2',
  negativePrompt: '3',
  sampler: '5',
  checkpoint: '1',
  latent: '4',
});

const PRESET_PARAMETER_KEYS = [
  'positivePrompt',
  'negativePrompt',
  'seed',
  'width',
  'height',
  'model',
] as const;

type PresetParameterKey = typeof PRESET_PARAMETER_KEYS[number];
type PresetParameterNodeIds = Record<PresetParameterKey, string | null>;

function presetParameterNodeIds(manifest: any): PresetParameterNodeIds {
  const raw = manifest?.parameterNodeIds;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ImportResultError(422, `Preset manifest '${manifest?.presetId || 'unknown'}' has no parameterNodeIds mapping.`);
  }
  const result = {} as PresetParameterNodeIds;
  for (const key of PRESET_PARAMETER_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new ImportResultError(422, `Preset manifest parameter mapping '${key}' is missing.`);
    }
    const value = raw[key];
    result[key] = value === null ? null : String(value).trim() || null;
  }
  return result;
}

function mappedPresetUiNode(uiWorkflow: any, nodeId: string, label: string): any {
  const parts = String(nodeId).split(':');
  if (parts.length > 2) {
    throw new ImportResultError(422, `Mapped ${label} node '${nodeId}' has an unsupported nested node ID.`);
  }
  if (parts.length === 1) {
    const matches = (uiWorkflow?.nodes || []).filter((node: any) => String(node.id) === parts[0]);
    if (matches.length !== 1) {
      throw new ImportResultError(422, `Mapped ${label} node '${nodeId}' is missing or duplicated in the UI workflow.`);
    }
    return matches[0];
  }

  const [outerId, innerId] = parts;
  const outerMatches = (uiWorkflow?.nodes || []).filter((node: any) => String(node.id) === outerId);
  if (outerMatches.length !== 1) {
    throw new ImportResultError(422, `Mapped ${label} subgraph '${outerId}' is missing or duplicated in the UI workflow.`);
  }
  const definitionMatches = (uiWorkflow?.definitions?.subgraphs || [])
    .filter((definition: any) => String(definition.id) === String(outerMatches[0].type));
  if (definitionMatches.length !== 1) {
    throw new ImportResultError(422, `Mapped ${label} subgraph definition for '${nodeId}' is missing or ambiguous.`);
  }
  const innerMatches = (definitionMatches[0].nodes || [])
    .filter((node: any) => String(node.id) === innerId);
  if (innerMatches.length !== 1) {
    throw new ImportResultError(422, `Mapped ${label} node '${nodeId}' is missing or duplicated in its UI subgraph.`);
  }
  return innerMatches[0];
}

function validatePresetManifest(
  manifest: any,
  apiWorkflow: any,
  uiWorkflow: any,
  expectedPresetId?: string,
): PresetParameterNodeIds {
  if (!manifest?.presetId || (expectedPresetId && manifest.presetId !== expectedPresetId)) {
    throw new ImportResultError(422, `Preset manifest ID does not match '${expectedPresetId || 'the requested preset'}'.`);
  }
  if (!Array.isArray(manifest.requiredMappings)) {
    throw new ImportResultError(422, `Preset manifest '${manifest.presetId}' has no requiredMappings list.`);
  }
  const mappings = presetParameterNodeIds(manifest);
  const executionNodeKeys: Partial<Record<PresetParameterKey, string>> = {
    positivePrompt: 'promptNodeId',
    seed: 'seedNodeId',
    width: 'widthNodeId',
    height: 'heightNodeId',
  };
  for (const required of manifest.requiredMappings) {
    if (!PRESET_PARAMETER_KEYS.includes(required)) {
      throw new ImportResultError(422, `Preset manifest required mapping '${required}' is unsupported.`);
    }
    if (!mappings[required as PresetParameterKey]) {
      throw new ImportResultError(422, `Preset manifest required mapping '${required}' is empty.`);
    }
    const executionKey = executionNodeKeys[required as PresetParameterKey];
    if (executionKey && String(manifest.nodeMappings?.[executionKey] || '') !== mappings[required as PresetParameterKey]) {
      throw new ImportResultError(422, `Preset manifest execution mapping '${executionKey}' does not match '${required}'.`);
    }
  }
  for (const key of PRESET_PARAMETER_KEYS) {
    const nodeId = mappings[key];
    if (!nodeId) continue;
    const apiNode = apiWorkflow?.[nodeId];
    if (!apiNode || typeof apiNode !== 'object' || !apiNode.class_type) {
      throw new ImportResultError(422, `Mapped preset node '${key}' (${nodeId}) is missing from the API workflow.`);
    }
    const uiNode = mappedPresetUiNode(uiWorkflow, nodeId, key);
    if (uiNode.type !== apiNode.class_type) {
      throw new ImportResultError(
        422,
        `Mapped preset node '${key}' (${nodeId}) type mismatch: API '${apiNode.class_type}', UI '${uiNode.type || 'unknown'}'.`,
      );
    }
  }
  if (manifest.modelMappings) {
    for (const [key, mapping] of Object.entries(manifest.modelMappings) as Array<[string, any]>) {
      const node = apiWorkflow?.[String(mapping.nodeId)];
      if (!node?.inputs || typeof node.inputs[mapping.inputKey] !== 'string') {
        throw new ImportResultError(422, `Preset model mapping '${key}' is invalid.`);
      }
    }
    if (manifest.modelMappings.baseModel && String(manifest.modelMappings.baseModel.nodeId) !== String(mappings.model || '')) {
      throw new ImportResultError(422, "Preset baseModel mapping must match parameterNodeIds.model.");
    }
  }
  return mappings;
}

function validatePresetReferenceMapping(manifest: any, apiWorkflow: any): { nodeId: string; inputKey: string } {
  const nodeId = String(manifest?.nodeMappings?.loadImageNodeId || '');
  const inputKey = String(manifest?.nodeMappings?.loadImageInputKey || '');
  if (!nodeId || !inputKey) {
    throw new ImportResultError(422, `Preset '${manifest?.presetId || 'unknown'}' has no explicit reference image mapping.`);
  }
  const node = apiWorkflow?.[nodeId];
  if (!node || node.class_type !== 'LoadImage' || !node.inputs || !(inputKey in node.inputs)) {
    throw new ImportResultError(422, `Preset '${manifest.presetId}' reference mapping does not point to a verified LoadImage input.`);
  }
  return { nodeId, inputKey };
}

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_IMPORT_METADATA_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_CHUNK_BYTES = 8 * 1024 * 1024;

class ImportResultError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

function validateAllPresetManifests() {
  const presetDirectory = path.resolve('workflows/character');
  if (!fs.existsSync(presetDirectory)) return;
  for (const filename of fs.readdirSync(presetDirectory).filter(name => name.endsWith('.manifest.json'))) {
    const manifestPath = path.join(presetDirectory, filename);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const apiWorkflow = JSON.parse(fs.readFileSync(path.resolve(presetDirectory, manifest.apiFile), 'utf8'));
    const uiWorkflow = JSON.parse(fs.readFileSync(path.resolve(presetDirectory, manifest.uiFile), 'utf8'));
    validatePresetManifest(manifest, apiWorkflow, uiWorkflow, manifest.presetId);
  }
}

validateAllPresetManifests();

const presetImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 3 },
});

async function presetAvailability(publicPresetId: string, workflowPresetId: string | null) {
  const metadata = workflowPresetId ? BUILTIN_PRESET_METADATA[workflowPresetId] : BUILTIN_PRESET_METADATA[publicPresetId];
  if (!workflowPresetId) {
    try {
      const checkpoints = await getComfyCheckpointsList();
      const modelName = process.env.COMFYUI_CKPT_NAME || checkpoints[0] || metadata?.modelName || 'SDXL Checkpoint';
      return { available: checkpoints.length > 0 || !!process.env.COMFYUI_CKPT_NAME, modelName, missingModels: checkpoints.length ? [] : ['SDXL Checkpoint'], missingNodes: [], reason: checkpoints.length || process.env.COMFYUI_CKPT_NAME ? null : 'ComfyUI 未发现可用 SDXL Checkpoint' };
    } catch (error: any) {
      return { available: false, modelName: metadata?.modelName || 'SDXL Checkpoint', missingModels: ['SDXL Checkpoint'], missingNodes: [], reason: `无法验证 ComfyUI：${error.message}` };
    }
  }

  const manifestPath = resolvePresetManifestPath(workflowPresetId);
  if (!manifestPath) return { available: false, modelName: '未知模型', missingModels: [], missingNodes: [], reason: '缺少 preset manifest' };
  try {
    const directory = path.dirname(manifestPath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const apiWorkflow = JSON.parse(fs.readFileSync(path.join(directory, manifest.apiFile), 'utf8'));
    const uiWorkflow = JSON.parse(fs.readFileSync(path.join(directory, manifest.uiFile), 'utf8'));
    validatePresetManifest(manifest, apiWorkflow, uiWorkflow, workflowPresetId);
    const requiredModels = Array.isArray(manifest.requiredModels) ? manifest.requiredModels.map(String) : [];
    const requiredNodes = [...new Set(Object.values(apiWorkflow).map((node: any) => String(node?.class_type || '')).filter(Boolean))];
    try {
      const objectInfoResponse = await comfyFetch('/object_info', {}, 5000);
      const objectInfo = await objectInfoResponse.json();
      const serializedInfo = JSON.stringify(objectInfo);
      const missingModels = requiredModels.filter((model: string) => !serializedInfo.includes(model));
      const missingNodes = requiredNodes.filter((nodeType: string) => !objectInfo?.[nodeType]);
      const reason = missingModels.length
        ? `缺少模型：${missingModels.join('、')}`
        : missingNodes.length ? `缺少节点：${missingNodes.join('、')}` : null;
      return { available: !reason, modelName: requiredModels[0] || metadata?.modelName || '工作流内置模型', missingModels, missingNodes, reason };
    } catch (error: any) {
      return { available: false, modelName: requiredModels[0] || metadata?.modelName || '工作流内置模型', missingModels: [], missingNodes: [], reason: `无法验证 ComfyUI：${error.message}` };
    }
  } catch (error: any) {
    return { available: false, modelName: '未知模型', missingModels: [], missingNodes: [], reason: error.message || '工作流文件校验失败' };
  }
}

app.get('/api/comfyui/presets', async (req, res) => {
  const requestedPurpose = String(req.query.purpose || '') as PresetPurpose | '';
  const builtins = [
    { presetId: 'sdxl_legacy', workflowPresetId: null },
    { presetId: 'pure_klein', workflowPresetId: '01_klein_character_master' },
    { presetId: 'pulid_flux2', workflowPresetId: '02_klein_pulid_identity' },
    { presetId: 'qwen_2511_three_views', workflowPresetId: '03_qwen_2511_three_views' },
    { presetId: 'esrgan_4x', workflowPresetId: '04_esrgan_upscale' },
  ];
  const imported = fs.existsSync(LOCAL_PRESET_DIR)
    ? fs.readdirSync(LOCAL_PRESET_DIR).filter(name => name.endsWith('.manifest.json')).map(name => {
      const manifest = JSON.parse(fs.readFileSync(path.join(LOCAL_PRESET_DIR, name), 'utf8'));
      return { presetId: String(manifest.presetId), workflowPresetId: String(manifest.presetId) };
    })
    : [];
  const presets = await Promise.all([...builtins, ...imported].map(async item => {
    const metadataId = item.workflowPresetId || item.presetId;
    const metadata = BUILTIN_PRESET_METADATA[metadataId];
    const manifestPath = item.workflowPresetId ? resolvePresetManifestPath(item.workflowPresetId) : null;
    const manifest = manifestPath ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
    const purposes = metadata?.purposes || presetPurposes(metadataId);
    return {
      presetId: item.presetId,
      workflowPresetId: item.workflowPresetId,
      displayName: metadata?.displayName || manifest?.displayName || item.presetId,
      workflowFamily: metadata?.workflowFamily || manifest?.workflowFamily || 'custom',
      purposes,
      ...(await presetAvailability(item.presetId, item.workflowPresetId)),
    };
  }));
  return res.json({ presets: requestedPurpose ? presets.filter(preset => preset.purposes.includes(requestedPurpose)) : presets });
});

app.post('/api/comfyui/presets/import', presetImportUpload.fields([
  { name: 'manifest', maxCount: 1 },
  { name: 'uiWorkflow', maxCount: 1 },
  { name: 'apiWorkflow', maxCount: 1 },
]), (req, res) => {
  try {
    const files = req.files as Record<string, Express.Multer.File[]>;
    const manifestFile = files?.manifest?.[0];
    const uiFile = files?.uiWorkflow?.[0];
    const apiFile = files?.apiWorkflow?.[0];
    if (!manifestFile || !uiFile || !apiFile) return res.status(400).json({ error: '必须同时提供 manifest、UI workflow 和 API workflow' });
    const manifest = JSON.parse(manifestFile.buffer.toString('utf8'));
    const uiWorkflow = JSON.parse(uiFile.buffer.toString('utf8'));
    const apiWorkflow = JSON.parse(apiFile.buffer.toString('utf8'));
    const presetId = String(manifest.presetId || '');
    if (!/^[a-zA-Z0-9_-]+$/.test(presetId)) return res.status(422).json({ error: 'manifest presetId 只能包含字母、数字、下划线和连字符' });
    if (BUILTIN_PRESET_METADATA[presetId] || PROJECT_PRESET_TO_WORKFLOW[presetId] !== undefined) return res.status(409).json({ error: '不能覆盖内置工作流预设' });
    if (!Array.isArray(manifest.purposes) || !manifest.purposes.length) return res.status(422).json({ error: 'manifest 必须显式声明 purposes；系统不会自动猜用途或节点' });
    if (manifest.apiFile !== apiFile.originalname || manifest.uiFile !== uiFile.originalname) return res.status(422).json({ error: 'manifest 中的 apiFile/uiFile 必须与上传文件名完全一致' });
    validatePresetManifest(manifest, apiWorkflow, uiWorkflow, presetId);
    fs.mkdirSync(LOCAL_PRESET_DIR, { recursive: true });
    const manifestName = `${presetId}.manifest.json`;
    if ([manifestName, manifest.apiFile, manifest.uiFile].some((name: string) => fs.existsSync(path.join(LOCAL_PRESET_DIR, name)))) return res.status(409).json({ error: '本地预设已存在，请更换 presetId 或文件名' });
    fs.writeFileSync(path.join(LOCAL_PRESET_DIR, manifestName), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(LOCAL_PRESET_DIR, manifest.apiFile), JSON.stringify(apiWorkflow, null, 2));
    fs.writeFileSync(path.join(LOCAL_PRESET_DIR, manifest.uiFile), JSON.stringify(uiWorkflow, null, 2));
    return res.status(201).json({ success: true, presetId });
  } catch (error: any) {
    const status = error instanceof ImportResultError ? error.status : 422;
    return res.status(status).json({ error: error.message || '导入预设失败' });
  }
});

function taskParameterNodeIds(uiWorkflow: any): Record<keyof typeof DEFAULT_PARAMETER_NODE_IDS, string> {
  const embedded = uiWorkflow?.extra?.aiVideoWorkbench?.parameterNodeIds;
  if (embedded) {
    const result: any = {};
    for (const key of Object.keys(DEFAULT_PARAMETER_NODE_IDS) as Array<keyof typeof DEFAULT_PARAMETER_NODE_IDS>) {
      const value = embedded[key];
      if (value === undefined || value === null || String(value).trim() === '') {
        throw new ImportResultError(422, `Workflow node mapping '${key}' is missing.`);
      }
      result[key] = String(value);
    }
    return result;
  }

  // Legacy built-in snapshots use these exact, stable node IDs. Never infer by selecting the first node of a type.
  const expectedTypes: Record<string, string> = {
    '1': 'CheckpointLoaderSimple',
    '2': 'CLIPTextEncode',
    '3': 'CLIPTextEncode',
    '4': 'EmptyLatentImage',
    '5': 'KSampler',
  };
  const nodes = new Map((uiWorkflow?.nodes || []).map((node: any) => [String(node.id), node.type]));
  if (!Object.entries(expectedTypes).every(([id, type]) => nodes.get(id) === type)) {
    throw new ImportResultError(422, 'Workflow has no explicit parameter node mapping and is not a built-in workflow snapshot.');
  }
  return { ...DEFAULT_PARAMETER_NODE_IDS };
}

function exportedUiWorkflow(task: any): any {
  let workflow: any;
  try {
    workflow = JSON.parse(task.uiWorkflowJson);
  } catch {
    throw new ImportResultError(409, `Task '${task.id}' UI workflow JSON is corrupted or invalid.`);
  }

  // Preset tasks already contain their exact UI workflow snapshot. Export a decorated copy only;
  // never rebuild it from the global SDXL template and never mutate the stored task JSON.
  if (task.workflowPresetId && task.workflowPresetId !== 'sdxl_legacy') {
    const manifestPath = resolvePresetManifestPath(task.workflowPresetId);
    if (!manifestPath || !fs.existsSync(manifestPath)) {
      throw new ImportResultError(409, `Task '${task.id}' preset manifest is no longer available.`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    let apiWorkflow: any;
    try {
      apiWorkflow = JSON.parse(task.apiWorkflowJson || '');
    } catch {
      throw new ImportResultError(409, `Task '${task.id}' API workflow JSON is corrupted or invalid.`);
    }
    workflow = applyPresetUiParameters(workflow, manifest, {
      prompt: task.prompt,
      negativePrompt: task.negativePrompt,
      seed: task.seed,
      width: task.width,
      height: task.height,
      model: task.model,
    });
    const parameterNodeIds = validatePresetManifest(
      manifest,
      apiWorkflow,
      workflow,
      task.workflowPresetId,
    );
    workflow.extra = {
      ...(workflow.extra && typeof workflow.extra === 'object' ? workflow.extra : {}),
      aiVideoWorkbench: {
        schemaVersion: 1,
        sourceTaskId: task.id,
        projectId: task.projectId,
        targetId: task.targetId,
        targetType: task.targetType,
        viewType: task.viewType,
        workflowPresetId: task.workflowPresetId,
        parameterNodeIds,
        requiredMappings: manifest.requiredMappings,
      },
    };
    return workflow;
  }

  let parameterNodeIds: Record<keyof typeof DEFAULT_PARAMETER_NODE_IDS, string>;
  try {
    parameterNodeIds = taskParameterNodeIds(workflow);
  } catch (error) {
    // Some records created by older builds accidentally stored the API workflow in uiWorkflowJson.
    // Rebuild only when apiWorkflowJson is unmistakably the built-in 1..7 workflow; never guess custom nodes.
    let apiWorkflow: any;
    try {
      apiWorkflow = JSON.parse(task.apiWorkflowJson || '');
    } catch {
      throw error;
    }
    const expectedApiTypes: Record<string, string> = {
      '1': 'CheckpointLoaderSimple',
      '2': 'CLIPTextEncode',
      '3': 'CLIPTextEncode',
      '4': 'EmptyLatentImage',
      '5': 'KSampler',
      '6': 'VAEDecode',
      '7': 'SaveImage',
    };
    if (!Object.entries(expectedApiTypes).every(([id, type]) => apiWorkflow?.[id]?.class_type === type)) {
      throw error;
    }
    workflow = buildDefaultUIWorkflow(task.model, task.prompt, task.negativePrompt, task.width, task.height, task.seed);
    parameterNodeIds = { ...DEFAULT_PARAMETER_NODE_IDS };
  }
  workflow.extra = {
    ...(workflow.extra && typeof workflow.extra === 'object' ? workflow.extra : {}),
    aiVideoWorkbench: {
      schemaVersion: 1,
      sourceTaskId: task.id,
      projectId: task.projectId,
      targetId: task.targetId,
      targetType: task.targetType,
      viewType: task.viewType,
      parameterNodeIds,
    },
  };
  return workflow;
}

function targetImageDirectory(task: any): { absolute: string; relative: string } {
  const projectId = safePathSegment(task.projectId, 'unassigned');
  const targetDir = task.targetType === 'shot'
    ? path.join('shots', String(Math.max(0, Number(task.shotIndex) || 0) + 1).padStart(2, '0'))
    : path.join('characters', safePathSegment(task.characterName, 'character'));
  const relative = path.join('projects', projectId, targetDir);
  return { absolute: path.join(UPLOADS_DIR, relative), relative };
}

const importResultStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    try {
      const task = dbSqlite.prepare('SELECT * FROM comfyui_tasks WHERE id = ?').get(req.params.sourceTaskId) as any;
      if (!task) return cb(new ImportResultError(404, `Source task '${req.params.sourceTaskId}' not found.`), '');
      if (task.status !== 'succeeded') return cb(new ImportResultError(409, 'Source task must be succeeded before importing a result.'), '');
      const destination = targetImageDirectory(task).absolute;
      fs.mkdirSync(destination, { recursive: true });
      return cb(null, destination);
    } catch (error: any) {
      return cb(error, '');
    }
  },
  filename: (_req, _file, cb) => cb(null, `.comfy-import-${crypto.randomUUID()}.tmp`),
});

const importResultUpload = multer({
  storage: importResultStorage,
  limits: { fileSize: MAX_IMPORT_BYTES, files: 1, fields: 2 },
}).single('file');

function removeFileQuietly(filePath?: string) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') console.warn(`[ComfyUI Import] Could not remove temporary file ${filePath}:`, error);
  }
}

async function sha256File(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function validatePngStream(filePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const source = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    const parser = new StreamPng();
    let settled = false;
    let sawIend = false;
    const fail = (error: any) => {
      if (settled) return;
      settled = true;
      source.destroy();
      reject(error);
    };

    // Keep parsing memory bounded. streampng-v2 normally retains every chunk to support rewriting;
    // imports only need validation, so retain just small presence markers and the IHDR object.
    parser.addChunk = function addValidationChunk(chunk: any) {
      if (chunk.type === 'IHDR') this.IHDR = [chunk];
      else if (!this[chunk.type]) this[chunk.type] = [true];
      return this;
    };
    const processChunk = parser.process.bind(parser);
    parser.process = function boundedProcess() {
      try {
        if (this.parser.position() >= 8 && this.parser.remaining() >= 4) {
          const chunkLength = this.parser.peak(4).readUInt32BE(0);
          if (chunkLength > MAX_IMPORT_CHUNK_BYTES) {
            throw new Error(`PNG chunk exceeds the ${MAX_IMPORT_CHUNK_BYTES / 1024 / 1024}MB safety limit`);
          }
        }
        return processChunk();
      } catch (error) {
        fail(error);
        return this;
      }
    };
    parser.on('chunk', (chunk: any) => {
      try {
        const actual = chunk.crc;
        const computed = chunk.getComputedCrc();
        if (!Buffer.isBuffer(actual) || !Buffer.isBuffer(computed) || !actual.equals(computed)) {
          throw new Error(`CRC mismatch in ${chunk.type || 'unknown'} chunk`);
        }
        if (chunk.type === 'IEND') sawIend = true;
      } catch (error) {
        fail(error);
      }
    });
    parser.on('error', fail);
    source.on('error', fail);
    source.on('end', () => {
      setImmediate(() => {
        if (settled) return;
        const remaining = Number(parser.parser?.remaining?.() || 0);
        if (!sawIend || remaining !== 0) {
          fail(new Error(!sawIend ? 'PNG ended before a complete IEND chunk' : 'PNG contains trailing or incomplete chunk data'));
          return;
        }
        settled = true;
        resolve();
      });
    });
    source.pipe(parser);
  });
}

function requireMappedNode(
  apiWorkflow: any,
  uiWorkflow: any,
  nodeId: string,
  label: string,
  acceptedTypes: string[],
): any {
  const apiNode = apiWorkflow?.[nodeId];
  if (!apiNode || typeof apiNode !== 'object') {
    throw new ImportResultError(422, `Mapped ${label} node '${nodeId}' is missing from PNG prompt metadata.`);
  }
  if (!acceptedTypes.includes(apiNode.class_type)) {
    throw new ImportResultError(422, `Mapped ${label} node '${nodeId}' has invalid type '${apiNode.class_type || 'unknown'}'.`);
  }
  const uiMatches = (uiWorkflow?.nodes || []).filter((node: any) => String(node.id) === nodeId);
  if (uiMatches.length !== 1 || !acceptedTypes.includes(uiMatches[0]?.type)) {
    throw new ImportResultError(422, `Mapped ${label} node '${nodeId}' is missing, duplicated, or has an invalid UI workflow type.`);
  }
  return apiNode;
}

function presetTextValue(node: any): unknown {
  if (node?.class_type === 'PrimitiveStringMultiline') return node.inputs?.value;
  if (node?.class_type === 'CLIPTextEncode') return node.inputs?.text;
  if (node?.class_type === 'TextEncodeQwenImageEditPlus') return node.inputs?.prompt;
  return undefined;
}

function presetSeedValue(node: any): unknown {
  if (node?.class_type === 'RandomNoise') return node.inputs?.noise_seed;
  if (node?.class_type === 'KSampler') return node.inputs?.seed;
  if (node?.class_type === 'KSamplerAdvanced') return node.inputs?.noise_seed;
  return undefined;
}

function presetModelValue(node: any): unknown {
  if (node?.class_type === 'UNETLoader') return node.inputs?.unet_name;
  if (node?.class_type === 'CheckpointLoaderSimple') return node.inputs?.ckpt_name;
  if (node?.class_type === 'UpscaleModelLoader') return node.inputs?.model_name;
  return undefined;
}

function presetDimensionValue(node: any, dimension: 'width' | 'height'): unknown {
  if (node?.inputs && Object.prototype.hasOwnProperty.call(node.inputs, dimension)) {
    return node.inputs[dimension];
  }
  if (node?.class_type === 'PrimitiveInt') return node.inputs?.value;
  return undefined;
}

function extractPresetImportParameters(
  sourceTask: any,
  manifest: any,
  apiWorkflow: any,
  uiWorkflow: any,
  provenance: any,
) {
  const mappings = validatePresetManifest(manifest, apiWorkflow, uiWorkflow, sourceTask.workflowPresetId);
  const embedded = provenance?.parameterNodeIds;
  if (!embedded || typeof embedded !== 'object') {
    throw new ImportResultError(422, 'Workflow provenance has no preset parameterNodeIds mapping.');
  }
  for (const key of PRESET_PARAMETER_KEYS) {
    const embeddedValue = embedded[key] === null ? null : String(embedded[key] ?? '').trim() || null;
    if (embeddedValue !== mappings[key]) {
      throw new ImportResultError(422, `Workflow provenance mapping '${key}' does not match the preset manifest.`);
    }
  }

  const requiredMappings = new Set<string>(manifest.requiredMappings || []);
  const mappedNode = (key: PresetParameterKey) => {
    const nodeId = mappings[key];
    if (!nodeId) {
      if (requiredMappings.has(key)) {
        throw new ImportResultError(422, `Required preset mapping '${key}' is missing.`);
      }
      return null;
    }
    return apiWorkflow[nodeId];
  };

  const positiveNode = mappedNode('positivePrompt');
  if (!positiveNode) throw new ImportResultError(422, "Required preset mapping 'positivePrompt' is missing.");
  const prompt = presetTextValue(positiveNode);
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new ImportResultError(422, 'Mapped positive prompt node does not contain text.');
  }

  const negativeNode = mappedNode('negativePrompt');
  const negativeValue = negativeNode ? presetTextValue(negativeNode) : '';
  if (negativeNode && typeof negativeValue !== 'string') {
    throw new ImportResultError(422, 'Mapped negative prompt node does not contain text.');
  }
  const negativePrompt = typeof negativeValue === 'string' ? negativeValue : '';

  const seedNode = mappedNode('seed');
  const seedValue = seedNode ? presetSeedValue(seedNode) : sourceTask.seed;
  if ((typeof seedValue !== 'string' && typeof seedValue !== 'number') || String(seedValue).trim() === '') {
    throw new ImportResultError(422, 'Mapped seed node does not contain a valid seed.');
  }

  const modelNode = mappedNode('model');
  const modelValue = modelNode ? presetModelValue(modelNode) : sourceTask.model;
  if (typeof modelValue !== 'string' || !modelValue.trim()) {
    throw new ImportResultError(422, 'Mapped model node does not contain a valid model name.');
  }

  const widthNode = mappedNode('width');
  const heightNode = mappedNode('height');
  const width = Number(widthNode ? presetDimensionValue(widthNode, 'width') : sourceTask.width);
  const height = Number(heightNode ? presetDimensionValue(heightNode, 'height') : sourceTask.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 32768 || height > 32768) {
    throw new ImportResultError(422, 'Mapped preset dimensions are invalid.');
  }

  return {
    apiWorkflow,
    uiWorkflow,
    prompt,
    negativePrompt,
    seed: String(seedValue),
    model: modelValue,
    width,
    height,
    provenance,
  };
}

async function readImportedPng(filePath: string, sourceTask: any) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const signature = Buffer.alloc(8);
    const { bytesRead } = await handle.read(signature, 0, 8, 0);
    const expected = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (bytesRead !== 8 || !signature.equals(expected)) {
      throw new ImportResultError(422, 'Uploaded file does not have a valid PNG signature.');
    }
  } finally {
    await handle.close();
  }

  try {
    // Dedicated chunk parsing validates every CRC and boundary from a disk stream.
    await validatePngStream(filePath);
  } catch (error: any) {
    throw new ImportResultError(422, `Invalid PNG chunk structure or CRC: ${error?.message || 'validation failed'}`);
  }

  let metadata: Metadata;
  try {
    // sharp delegates PNG chunk, CRC, compression and bounds validation to maintained libvips/libpng.
    // metadata() reads headers/text metadata without decoding the full pixel raster.
    metadata = await sharp(filePath, { failOn: 'warning' }).metadata();
  } catch (error: any) {
    throw new ImportResultError(422, `Invalid or corrupted PNG: ${error?.message || 'metadata parsing failed'}`);
  }
  if (metadata.format !== 'png') throw new ImportResultError(422, 'Uploaded file is not a real PNG image.');

  const comments = metadata.comments || [];
  const metadataBytes = comments.reduce((sum, item) => sum + Buffer.byteLength(item.keyword || '') + Buffer.byteLength(item.text || ''), 0);
  if (metadataBytes > MAX_IMPORT_METADATA_BYTES) {
    throw new ImportResultError(422, 'PNG metadata exceeds the 5MB decompressed limit.');
  }
  const byKeyword = (keyword: string) => comments.filter(item => item.keyword === keyword);
  const promptComments = byKeyword('prompt');
  const workflowComments = byKeyword('workflow');
  if (promptComments.length !== 1 || workflowComments.length !== 1) {
    throw new ImportResultError(422, 'PNG must contain exactly one valid prompt and one valid workflow metadata entry.');
  }

  let apiWorkflow: any;
  let uiWorkflow: any;
  try {
    apiWorkflow = JSON.parse(promptComments[0].text);
    uiWorkflow = JSON.parse(workflowComments[0].text);
  } catch {
    throw new ImportResultError(422, 'PNG prompt or workflow metadata is not valid JSON.');
  }

  const provenance = uiWorkflow?.extra?.aiVideoWorkbench;
  if (!provenance || provenance.schemaVersion !== 1) {
    throw new ImportResultError(422, 'Workflow is missing supported aiVideoWorkbench provenance metadata.');
  }

  if (sourceTask.workflowPresetId && sourceTask.workflowPresetId !== 'sdxl_legacy') {
    if (String(provenance.workflowPresetId || '') !== String(sourceTask.workflowPresetId)) {
      throw new ImportResultError(422, "Workflow provenance 'workflowPresetId' does not match the source task.");
    }
    const manifestPath = resolvePresetManifestPath(sourceTask.workflowPresetId);
    if (!manifestPath || !fs.existsSync(manifestPath)) {
      throw new ImportResultError(422, `Preset manifest '${sourceTask.workflowPresetId}' is unavailable.`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return extractPresetImportParameters(sourceTask, manifest, apiWorkflow, uiWorkflow, provenance);
  }

  const ids = taskParameterNodeIds(uiWorkflow);
  const positive = requireMappedNode(apiWorkflow, uiWorkflow, ids.positivePrompt, 'positive prompt', ['CLIPTextEncode']);
  const negative = requireMappedNode(apiWorkflow, uiWorkflow, ids.negativePrompt, 'negative prompt', ['CLIPTextEncode']);
  const sampler = requireMappedNode(apiWorkflow, uiWorkflow, ids.sampler, 'sampler', ['KSampler', 'KSamplerAdvanced']);
  const checkpoint = requireMappedNode(apiWorkflow, uiWorkflow, ids.checkpoint, 'checkpoint', ['CheckpointLoaderSimple']);
  const latent = requireMappedNode(apiWorkflow, uiWorkflow, ids.latent, 'latent', ['EmptyLatentImage', 'EmptySD3LatentImage']);

  const prompt = positive.inputs?.text;
  const negativePrompt = negative.inputs?.text;
  const seed = sampler.class_type === 'KSamplerAdvanced' ? sampler.inputs?.noise_seed : sampler.inputs?.seed;
  const model = checkpoint.inputs?.ckpt_name;
  const width = Number(latent.inputs?.width);
  const height = Number(latent.inputs?.height);
  if (typeof prompt !== 'string' || typeof negativePrompt !== 'string') {
    throw new ImportResultError(422, 'Mapped prompt nodes do not contain text inputs.');
  }
  if ((typeof seed !== 'string' && typeof seed !== 'number') || String(seed).trim() === '') {
    throw new ImportResultError(422, 'Mapped sampler node does not contain a valid seed.');
  }
  if (typeof model !== 'string' || !model.trim()) {
    throw new ImportResultError(422, 'Mapped checkpoint node does not contain a valid model name.');
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 32768 || height > 32768) {
    throw new ImportResultError(422, 'Mapped latent node does not contain valid width and height values.');
  }
  return { apiWorkflow, uiWorkflow, prompt, negativePrompt, seed: String(seed), model, width, height, provenance };
}

function updateImportedSlot(scripts: any[], task: any, imageUrl: string, generation: any) {
  const script = scripts.find((item: any) => String(item.id) === String(task.projectId));
  if (!script) throw new ImportResultError(422, 'The source task project no longer exists.');
  if (task.targetType === 'shot') {
    if (task.viewType !== 'main') throw new ImportResultError(422, `Unsupported shot slot '${task.viewType}'.`);
    const shot = script.newShots?.find((item: any) => String(item.id) === String(task.targetId));
    if (!shot) throw new ImportResultError(422, 'The source shot slot no longer exists.');
    shot.imageUrl = imageUrl;
    shot.generatedImageUrl = imageUrl;
    shot.imageGeneration = generation;
    shot.imageGenerations = [...(shot.imageGenerations || []), generation];
    return;
  }
  if (task.targetType === 'character') {
    if (!['avatar', 'front', 'side', 'back'].includes(task.viewType)) {
      throw new ImportResultError(422, `Unsupported character slot '${task.viewType}'.`);
    }
    const character = script.newCharacters?.find((item: any) => String(item.id) === String(task.targetId));
    if (!character) throw new ImportResultError(422, 'The source character slot no longer exists.');
    if (task.viewType === 'avatar') {
      character.avatarUrl = imageUrl;
      character.avatarImageUrl = imageUrl;
      character.sourceTaskId = task.id;
      character.hasReference = true;
    } else {
      character.views = { ...(character.views || {}), [task.viewType]: imageUrl };
      if (task.viewType === 'front') character.avatarUrl = imageUrl;
    }
    character.imageGeneration = generation;
    character.imageGenerations = [...(character.imageGenerations || []), generation];
    return;
  }
  throw new ImportResultError(422, `Unsupported target type '${task.targetType}'.`);
}

function publicComfyTask(task: any) {
  let hasUiWorkflow = false;
  try {
    exportedUiWorkflow(task);
    hasUiWorkflow = true;
  } catch {
    hasUiWorkflow = false;
  }
  const { apiWorkflowJson: _apiWorkflowJson, uiWorkflowJson: _uiWorkflowJson, ...publicTask } = task;
  return { ...publicTask, errorMessage: publicTask.error || null, outputImageUrl: publicTask.imageUrl || null, hasUiWorkflow };
}

function storedGeneratedScript(projectId: string) {
  const row = dbSqlite.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get() as { value: string } | undefined;
  let scripts: any[];
  try {
    scripts = row ? JSON.parse(row.value) : [];
  } catch {
    throw new ImportResultError(500, 'Stored project data is corrupted.');
  }
  const script = scripts.find(item => String(item.id) === String(projectId));
  if (!script) throw new ImportResultError(422, 'The source task project no longer exists.');
  return script;
}

app.get('/api/comfyui/tasks', (req, res) => {
  const projectId = req.query.projectId;
  if (!projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }
  try {
    const timeoutCutoff = new Date(Date.now() - 10 * 60_000).toISOString();
    const staleTasks = dbSqlite.prepare(`SELECT id,targetId,workflowPresetId,comfyPromptId FROM comfyui_tasks WHERE projectId=? AND status IN ('pending','processing') AND createdAt < ?`).all(projectId, timeoutCutoff) as any[];
    for (const stale of staleTasks) {
      const error = 'Task timed out after 10 minutes';
      dbSqlite.prepare(`UPDATE comfyui_tasks SET status='failed', stateDetail='timeout', error=?, completedAt=?, updatedAt=? WHERE id=? AND status IN ('pending','processing')`).run(error, new Date().toISOString(), new Date().toISOString(), stale.id);
      console.error('[TaskState:Timeout]', JSON.stringify({ taskId: stale.id, shotId: stale.targetId, presetId: stale.workflowPresetId || null, prompt_id: stale.comfyPromptId || null, status: 'timeout', error }));
    }
    const tasks = dbSqlite.prepare(`
      SELECT
        id, projectId, targetId, targetType, viewType, shotIndex, characterName,
        prompt, negativePrompt, seed, model, width, height, status, retryCount,
        retryOfTaskId, supersededByTaskId, error, recoveryCheckCount, missingSince,
        origin, importedFromTaskId, importSha256, imageUrl,
        workflowPresetId, workflowFamily, workflowBatchId, sourceImageUrl, sourceTaskId,
        outputNodeId, presetParametersJson,
        characterReferenceImageUrl, characterReferenceTaskId, lockCharacterIdentity,
        createdAt, submittedAt, completedAt, updatedAt,
        apiWorkflowJson, uiWorkflowJson, batchOrder, comfyPromptId, queuePosition, stateDetail
      FROM comfyui_tasks
      WHERE projectId = ?
      ORDER BY createdAt ASC
    `).all(projectId) as any[];

    const skipped = dbSqlite.prepare(`
      SELECT i.*, b.createdAt AS batchCreatedAt
      FROM comfyui_shot_batch_items i
      JOIN comfyui_shot_batches b ON b.id = i.batchId
      WHERE i.projectId = ? AND i.taskId IS NULL AND i.finalStatus IN ('skipped_missing_avatar', 'failed')
    `).all(projectId) as any[];
    const mapped = tasks.map(publicComfyTask).concat(skipped.map(item => ({
      id: `batch-item:${item.id}`,
      projectId: item.projectId,
      targetId: item.targetId,
      targetType: 'shot',
      viewType: 'main',
      shotIndex: item.shotIndex,
      status: item.finalStatus,
      error: item.error,
      workflowPresetId: item.workflowPresetId,
      workflowBatchId: item.batchId,
      characterReferenceImageUrl: item.characterReferenceImageUrl,
      workflowInjected: !!item.workflowInjected,
      matchedCharacters: JSON.parse(item.matchedCharactersJson || '[]'),
      finalStatus: item.finalStatus,
      batchOrder: item.batchOrder,
      createdAt: item.batchCreatedAt,
      updatedAt: item.updatedAt,
      syntheticBatchItem: true,
    })));
    return res.json(mapped);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/comfyui/tasks/:taskId/export-workflow', (req, res) => {
  const { taskId } = req.params;
  try {
    const task = dbSqlite.prepare(`
      SELECT * FROM comfyui_tasks WHERE id = ?
    `).get(taskId) as any;

    if (!task) {
      return res.status(404).json({ error: `Task '${taskId}' not found.` });
    }

    if (task.status !== 'succeeded') {
      return res.status(409).json({ error: `Task '${taskId}' is in status '${task.status}'. Only succeeded tasks can export workflows.` });
    }

    if (!task.uiWorkflowJson || !task.uiWorkflowJson.trim()) {
      return res.status(409).json({ error: `Task '${taskId}' does not have a valid ComfyUI UI workflow.` });
    }

    const workflow = exportedUiWorkflow(task);

    const safeTargetType = safePathSegment(task.targetType, 'unknown');
    const safeViewType = safePathSegment(task.viewType, 'main');
    const filename = `comfyui_${safeTargetType}_${safeViewType}_${task.id}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(JSON.stringify(workflow, null, 2));
  } catch (err: any) {
    return res.status(err instanceof ImportResultError ? err.status : 500).json({ error: err.message });
  }
});

app.post('/api/comfyui/tasks/:sourceTaskId/import-result', (req, res) => {
  let uploadedPath: string | undefined;
  let finalPath: string | undefined;
  let requestAborted = false;
  req.once('aborted', () => {
    requestAborted = true;
    removeFileQuietly(uploadedPath || req.file?.path);
  });

  importResultUpload(req, res, async uploadError => {
    uploadedPath = req.file?.path;
    try {
      if (uploadError) {
        if (uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE') {
          throw new ImportResultError(413, 'PNG file exceeds the 50MB upload limit.');
        }
        throw uploadError;
      }
      if (requestAborted) throw new ImportResultError(400, 'Upload request was interrupted.');
      if (!req.file || !uploadedPath) throw new ImportResultError(400, "A PNG file is required in the 'file' field.");

      const sourceTask = dbSqlite.prepare('SELECT * FROM comfyui_tasks WHERE id = ?').get(req.params.sourceTaskId) as any;
      if (!sourceTask) throw new ImportResultError(404, `Source task '${req.params.sourceTaskId}' not found.`);
      if (sourceTask.status !== 'succeeded') throw new ImportResultError(409, 'Source task must be succeeded before importing a result.');

      const imported = await readImportedPng(uploadedPath, sourceTask);
      const provenance = imported.provenance;

      if (!provenance || provenance.schemaVersion !== 1) {
        throw new ImportResultError(422, 'Workflow is missing supported aiVideoWorkbench provenance metadata.');
      }

      if (sourceTask.targetType !== provenance.targetType) {
        throw new ImportResultError(422, "Workflow provenance 'targetType' does not match the source task.");
      }
      if (sourceTask.targetType === 'character' && provenance.targetType !== 'character') {
        throw new ImportResultError(422, 'Workflow provenance targetType must be character.');
      }

      if (String(provenance.sourceTaskId ?? '') !== String(sourceTask.id)) {
        throw new ImportResultError(422, "Workflow provenance 'sourceTaskId' does not match the source task.");
      }
      if (String(provenance.projectId ?? '') !== String(sourceTask.projectId)) {
        throw new ImportResultError(422, "Workflow provenance 'projectId' does not match the source task.");
      }
      if (String(provenance.targetId ?? '') !== String(sourceTask.targetId)) {
        throw new ImportResultError(422, "Workflow provenance 'targetId' does not match the source task.");
      }
      if (String(provenance.viewType ?? '') !== String(sourceTask.viewType)) {
        throw new ImportResultError(422, "Workflow provenance 'viewType' does not match the source task.");
      }

      const importSha256 = await sha256File(uploadedPath);
      const existing = dbSqlite.prepare(`
        SELECT * FROM comfyui_tasks
        WHERE origin = 'manual_import' AND importedFromTaskId = ? AND importSha256 = ?
      `).get(sourceTask.id, importSha256) as any;
      if (existing) {
        removeFileQuietly(uploadedPath);
        return res.json({
          success: true,
          duplicate: true,
          taskId: existing.id,
          projectId: existing.projectId,
          targetId: existing.targetId,
          targetType: existing.targetType,
          viewType: existing.viewType,
          task: publicComfyTask(existing),
          imageUrl: existing.imageUrl,
          updatedScript: storedGeneratedScript(existing.projectId),
          parameters: {
            prompt: existing.prompt,
            negativePrompt: existing.negativePrompt,
            seed: existing.seed,
            model: existing.model,
            width: existing.width,
            height: existing.height,
          },
        });
      }

      const newTaskId = crypto.randomUUID();
      const paths = targetImageDirectory(sourceTask);
      const finalFilename = `comfyui-import-${importSha256}-${newTaskId}.png`;
      finalPath = path.join(paths.absolute, finalFilename);
      fs.renameSync(uploadedPath, finalPath);
      uploadedPath = undefined;
      const imageUrl = `/uploads/${paths.relative.replace(/\\/g, '/')}/${finalFilename}`;
      const now = new Date().toISOString();
      const force = req.query.force === 'true' || req.body?.force === 'true';

      const transaction = dbSqlite.transaction(() => {
        const lockedSource = dbSqlite.prepare('SELECT * FROM comfyui_tasks WHERE id = ?').get(sourceTask.id) as any;
        if (!lockedSource || lockedSource.status !== 'succeeded') {
          throw new ImportResultError(409, 'Source task is no longer a succeeded task.');
        }
        const racedDuplicate = dbSqlite.prepare(`
          SELECT * FROM comfyui_tasks
          WHERE origin = 'manual_import' AND importedFromTaskId = ? AND importSha256 = ?
        `).get(lockedSource.id, importSha256) as any;
        if (racedDuplicate) {
          return {
            duplicate: racedDuplicate,
            task: racedDuplicate,
            updatedScript: storedGeneratedScript(racedDuplicate.projectId),
          };
        }

        const latest = dbSqlite.prepare(`
          SELECT id FROM comfyui_tasks
          WHERE projectId = ? AND targetId = ? AND targetType = ? AND viewType = ? AND status = 'succeeded'
          ORDER BY COALESCE(completedAt, createdAt) DESC, createdAt DESC, rowid DESC
          LIMIT 1
        `).get(lockedSource.projectId, lockedSource.targetId, lockedSource.targetType, lockedSource.viewType) as any;
        if (!force && latest && latest.id !== lockedSource.id) {
          throw new ImportResultError(409, 'A newer successful result exists for this slot. Confirm force import to replace it.', 'STALE_SOURCE');
        }

        const scriptsRow = dbSqlite.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get() as { value: string } | undefined;
        let scripts: any[];
        try {
          scripts = scriptsRow ? JSON.parse(scriptsRow.value) : [];
        } catch {
          throw new ImportResultError(500, 'Stored project data is corrupted.');
        }
        const generation = {
          provider: 'comfyui',
          origin: 'manual_import',
          status: 'succeeded',
          prompt: imported.prompt,
          negativePrompt: imported.negativePrompt,
          seed: imported.seed,
          model: imported.model,
          width: imported.width,
          height: imported.height,
          promptId: newTaskId,
          importedFromTaskId: lockedSource.id,
          importSha256,
          projectId: lockedSource.projectId,
          targetId: lockedSource.targetId,
          targetType: lockedSource.targetType,
          viewType: lockedSource.viewType,
          ...(lockedSource.shotIndex !== null ? { shotIndex: lockedSource.shotIndex } : {}),
          ...(lockedSource.characterName ? { characterName: lockedSource.characterName } : {}),
          createdAt: now,
        };
        updateImportedSlot(scripts, lockedSource, imageUrl, generation);

        dbSqlite.prepare(`
          INSERT INTO comfyui_tasks (
            id, projectId, targetId, targetType, viewType, shotIndex, characterName,
            prompt, negativePrompt, seed, model, width, height, status, retryCount,
            imageUrl, apiWorkflowJson, uiWorkflowJson, origin, importedFromTaskId, importSha256,
            createdAt, submittedAt, completedAt, updatedAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'succeeded', 0, ?, ?, ?, 'manual_import', ?, ?, ?, ?, ?, ?)
        `).run(
          newTaskId, lockedSource.projectId, lockedSource.targetId, lockedSource.targetType, lockedSource.viewType,
          lockedSource.shotIndex, lockedSource.characterName, imported.prompt, imported.negativePrompt,
          imported.seed, imported.model, imported.width, imported.height, imageUrl,
          JSON.stringify(imported.apiWorkflow), JSON.stringify(imported.uiWorkflow), lockedSource.id, importSha256,
          now, now, now, now
        );
        dbSqlite.prepare("INSERT OR REPLACE INTO store (key, value) VALUES ('generated_scripts', ?)").run(JSON.stringify(scripts));
        const task = dbSqlite.prepare('SELECT * FROM comfyui_tasks WHERE id = ?').get(newTaskId) as any;
        const updatedScript = scripts.find(item => String(item.id) === String(lockedSource.projectId));
        return { duplicate: null, task, updatedScript };
      });

      const result: any = transaction();
      if (result.duplicate) {
        removeFileQuietly(finalPath);
        finalPath = undefined;
        return res.json({
          success: true,
          duplicate: true,
          taskId: result.duplicate.id,
          projectId: result.duplicate.projectId,
          targetId: result.duplicate.targetId,
          targetType: result.duplicate.targetType,
          viewType: result.duplicate.viewType,
          task: publicComfyTask(result.task),
          imageUrl: result.duplicate.imageUrl,
          updatedScript: result.updatedScript,
          parameters: {
            prompt: result.duplicate.prompt,
            negativePrompt: result.duplicate.negativePrompt,
            seed: result.duplicate.seed,
            model: result.duplicate.model,
            width: result.duplicate.width,
            height: result.duplicate.height,
          },
        });
      }

      finalPath = undefined;
      return res.status(201).json({
        success: true,
        duplicate: false,
        taskId: newTaskId,
        projectId: sourceTask.projectId,
        targetId: sourceTask.targetId,
        targetType: sourceTask.targetType,
        viewType: sourceTask.viewType,
        task: publicComfyTask(result.task),
        imageUrl,
        updatedScript: result.updatedScript,
        parameters: {
          prompt: imported.prompt,
          negativePrompt: imported.negativePrompt,
          seed: imported.seed,
          model: imported.model,
          width: imported.width,
          height: imported.height,
        },
      });
    } catch (error: any) {
      removeFileQuietly(uploadedPath);
      removeFileQuietly(finalPath);
      if (requestAborted || res.headersSent) return;
      const status = error instanceof ImportResultError ? error.status : 500;
      const payload: any = { error: error?.message || 'ComfyUI result import failed.' };
      if (error instanceof ImportResultError && error.code) payload.code = error.code;
      return res.status(status).json(payload);
    }
  });
});

app.get('/api/comfyui/open-ui', (req, res) => {
  try {
    const url = comfyBaseUrl();
    return res.redirect(url);
  } catch (err: any) {
    return res.status(500).send(`Error getting ComfyUI URL: ${err.message}`);
  }
});

app.get('/api/comfyui/workflow-template', async (req, res) => {
  try {
    const requestedPreset = String(req.query.presetId || 'sdxl_legacy');
    const workflowPresetId = workflowIdForSelection(requestedPreset);
    if (workflowPresetId === undefined) {
      return res.status(422).json({ error: `Unsupported workflow template: ${requestedPreset}` });
    }
    let workflow: any;
    let filename: string;
    if (!workflowPresetId) {
      const checkpoint = await getComfyCheckpoint();
      workflow = buildDefaultUIWorkflow(
        checkpoint,
        'cinematic storyboard frame, detailed composition, professional lighting',
        DEFAULT_COMFY_NEGATIVE_PROMPT,
        768,
        512,
        String(Number(BigInt(`0x${crypto.randomBytes(8).toString('hex')}`) % 9_007_199_254_740_991n)),
      );
      filename = 'comfyui_template_sdxl_legacy.json';
    } else {
      const manifestPath = resolvePresetManifestPath(workflowPresetId);
      if (!manifestPath || !fs.existsSync(manifestPath)) {
        return res.status(404).json({ error: `Workflow preset manifest not found: ${workflowPresetId}` });
      }
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      workflow = JSON.parse(fs.readFileSync(path.join(path.dirname(manifestPath), manifest.uiFile), 'utf8'));
      filename = `comfyui_template_${requestedPreset}.json`;
    }
    // Generic templates intentionally have no slot provenance and cannot be imported as a result.
    if (workflow.extra?.aiVideoWorkbench) delete workflow.extra.aiVideoWorkbench;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(JSON.stringify(workflow, null, 2));
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Could not build workflow template.' });
  }
});

app.get('/api/comfyui/default-workflow', async (_req, res) => {
  try {
    const checkpoint = await getComfyCheckpoint();
    const workflow = buildDefaultUIWorkflow(
      checkpoint,
      'cinematic storyboard frame, detailed composition, professional lighting',
      DEFAULT_COMFY_NEGATIVE_PROMPT,
      768,
      512,
      String(Number(BigInt(`0x${crypto.randomBytes(8).toString('hex')}`) % 9_007_199_254_740_991n)),
    );
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="comfyui_storyboard_default.json"');
    return res.send(JSON.stringify(workflow, null, 2));
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Could not build the default ComfyUI workflow.' });
  }
});

app.get('/api/comfyui/checkpoints', async (req, res) => {
  try {
    const list = await getComfyCheckpointsList();
    return res.json({ checkpoints: list });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/comfyui/workflow-info', (req, res) => {
  try {
    const presetId = String(req.query.presetId || '');
    if (presetId && presetId !== 'sdxl_legacy') {
      if (!/^[a-zA-Z0-9_-]+$/.test(presetId)) {
        return res.status(400).json({ error: 'Invalid workflow preset ID.' });
      }
      const manifestPath = resolvePresetManifestPath(presetId);
      if (!manifestPath || !fs.existsSync(manifestPath)) {
        return res.status(404).json({ error: `Workflow preset manifest not found: ${presetId}` });
      }
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const apiWorkflow = JSON.parse(fs.readFileSync(path.join(path.dirname(manifestPath), manifest.apiFile), 'utf8'));
      const uiWorkflow = JSON.parse(fs.readFileSync(path.join(path.dirname(manifestPath), manifest.uiFile), 'utf8'));
      validatePresetManifest(manifest, apiWorkflow, uiWorkflow, presetId);
      const modelFields = Object.entries(manifest.modelMappings || {}).map(([key, mapping]: [string, any]) => {
        const node = apiWorkflow[String(mapping.nodeId)];
        if (!node || !node.inputs || typeof node.inputs[mapping.inputKey] !== 'string') {
          throw new ImportResultError(422, `Preset model mapping '${key}' is invalid.`);
        }
        return {
          key,
          label: String(mapping.label || key),
          nodeId: String(mapping.nodeId),
          inputKey: String(mapping.inputKey),
          value: node.inputs[mapping.inputKey],
          editable: mapping.editable === true,
        };
      });
      return res.json({
        isCustom: false,
        presetId,
        modelParameterType: modelFields.length ? 'manifest' : 'readonly',
        modelFields,
        supported: {
          prompt: !!manifest.parameterNodeIds?.positivePrompt,
          negativePrompt: !!manifest.parameterNodeIds?.negativePrompt,
          seed: !!manifest.parameterNodeIds?.seed,
          model: modelFields.some((field: any) => field.editable),
          width: !!manifest.parameterNodeIds?.width,
          height: !!manifest.parameterNodeIds?.height,
        },
      });
    }
    const customWorkflow = loadCustomComfyWorkflow();
    if (!customWorkflow) {
      return res.json({
        isCustom: false,
        supported: {
          prompt: true,
          negativePrompt: true,
          seed: true,
          model: true,
          width: true,
          height: true
        }
      });
    }

    const checkpointNode = findComfyNode(customWorkflow, 'COMFYUI_CKPT_NODE_ID', ['CheckpointLoaderSimple'], /checkpoint/i);
    const positiveNode = findComfyNode(customWorkflow, 'COMFYUI_PROMPT_NODE_ID', ['CLIPTextEncode'], /positive|prompt/i);
    const negativeNode = findComfyNode(customWorkflow, 'COMFYUI_NEGATIVE_NODE_ID', ['CLIPTextEncode'], /negative/i);
    const seedNode = findComfyNode(customWorkflow, 'COMFYUI_SEED_NODE_ID', ['KSampler', 'KSamplerAdvanced'], /seed/i);
    const latentNode = findComfyNode(customWorkflow, 'COMFYUI_LATENT_NODE_ID', ['EmptyLatentImage', 'EmptySD3LatentImage'], /latent|size/i);

    return res.json({
      isCustom: true,
      supported: {
        model: !!checkpointNode,
        prompt: !!positiveNode,
        negativePrompt: !!negativeNode,
        seed: !!seedNode,
        width: !!latentNode,
        height: !!latentNode
      }
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/comfyui/tasks/last-succeeded', (req, res) => {
  const { targetId, viewType } = req.query;
  if (!targetId || !viewType) {
    return res.status(400).json({ error: 'targetId and viewType are required' });
  }
  try {
    const row = dbSqlite.prepare(`
      SELECT * FROM comfyui_tasks
      WHERE targetId = ? AND viewType = ? AND status = 'succeeded'
      ORDER BY createdAt DESC
      LIMIT 1
    `).get(targetId, viewType) as any;
    return res.json(row || {});
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/comfyui/tasks/:id/retry', async (req, res) => {
  const { id } = req.params;
  try {
    const oldTask = dbSqlite.prepare("SELECT * FROM comfyui_tasks WHERE id = ?").get(id) as any;
    if (!oldTask) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const newTaskId = crypto.randomUUID();
    const tx = dbSqlite.transaction(() => {
      // Cancel active tasks in the same slot
      dbSqlite.prepare(`
        UPDATE comfyui_tasks
        SET status = 'cancelled', supersededByTaskId = ?, error = 'Superseded by retry task', completedAt = ?, updatedAt = ?
        WHERE targetId = ? AND viewType = ? AND status IN ('pending', 'processing')
      `).run(newTaskId, new Date().toISOString(), new Date().toISOString(), oldTask.targetId, oldTask.viewType);

      // Insert new task with retryCount incremented
      dbSqlite.prepare(`
        INSERT INTO comfyui_tasks (
          id, projectId, targetId, targetType, viewType, shotIndex, characterName,
          prompt, negativePrompt, seed, model, width, height, status, retryCount, retryOfTaskId,
          apiWorkflowJson, uiWorkflowJson, createdAt, updatedAt,
          workflowPresetId, workflowFamily, sourceImageUrl, sourceTaskId, outputNodeId, presetParametersJson,
          characterReferenceImageUrl, characterReferenceTaskId, lockCharacterIdentity, workflowBatchId, batchOrder
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newTaskId,
        oldTask.projectId,
        oldTask.targetId,
        oldTask.targetType,
        oldTask.viewType,
        oldTask.shotIndex,
        oldTask.characterName,
        oldTask.prompt,
        oldTask.negativePrompt,
        oldTask.seed,
        oldTask.model,
        oldTask.width,
        oldTask.height,
        'pending',
        (oldTask.retryCount || 0) + 1,
        oldTask.id,
        oldTask.apiWorkflowJson,
        oldTask.uiWorkflowJson,
        new Date().toISOString(),
        new Date().toISOString(),
        oldTask.workflowPresetId,
        oldTask.workflowFamily,
        oldTask.sourceImageUrl,
        oldTask.sourceTaskId,
        oldTask.outputNodeId,
        oldTask.presetParametersJson,
        oldTask.characterReferenceImageUrl,
        oldTask.characterReferenceTaskId,
        oldTask.lockCharacterIdentity,
        oldTask.workflowBatchId,
        oldTask.batchOrder
      );
    });
    tx();

    console.log(`[Queue] Retried task ${id} as new task ${newTaskId}`);
    return res.json({ success: true, taskId: newTaskId });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/comfyui/tasks/:id/cancel', async (req, res) => {
  const { id } = req.params;
  try {
    const task = dbSqlite.prepare("SELECT * FROM comfyui_tasks WHERE id = ?").get(id) as any;
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') {
      return res.json({ success: true, message: 'Task is already completed or cancelled' });
    }

    // Cancel locally in SQLite first
    dbSqlite.prepare(`
      UPDATE comfyui_tasks
      SET status = 'cancelled', stateDetail = 'cancelled', queuePosition = NULL, completedAt = ?, updatedAt = ?
      WHERE id = ?
    `).run(new Date().toISOString(), new Date().toISOString(), id);

    const promptId = task.comfyPromptId || task.id;
    if (promptId) {
      console.log(`[Queue] Best-effort delete from ComfyUI queue for cancelled task ${id}`);
      comfyFetch('/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [promptId] })
      }).catch(err => {
        console.warn(`[Queue] Failed to delete task ${id} from ComfyUI queue:`, err.message);
      });
      if (task.status === 'processing') {
        comfyFetch('/interrupt', { method: 'POST' }).catch(err => {
          console.warn(`[Queue] Failed to interrupt processing task ${id}:`, err.message);
        });
      }
    }

    console.log(`[Queue] Cancelled task ${id} successfully.`);
    console.log('[TaskState:Update]', JSON.stringify({ taskId: id, shotId: task.targetId, presetId: task.workflowPresetId || null, prompt_id: promptId, status: 'cancelled', error: null }));
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

function getStyleEnglishBackend(style: string): string {
  switch (style) {
    case "写实":
      return "Cinematic photo-realistic, dramatic lighting, highly detailed, 8k resolution";
    case "动漫":
      return "Anime style, Japanese animation, cell-shaded, high quality";
    case "赛博朋克":
      return "Cyberpunk style, neon lights, dark alley reflections, futuristic";
    case "油画":
      return "Oil painting style, textured brush strokes, classical masterpiece, artistic";
    default:
      return "Cinematic, dramatic lighting, highly detailed";
  }
}

app.post('/api/comfyui/shots/generate-all', async (req, res) => {
  const { projectId, regenerateMode, confirmed } = req.body;
  if (!projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }

  try {
    // 1. Check if there is already an active batch for this project
    const activeBatchTask = dbSqlite.prepare(`
      SELECT workflowBatchId FROM comfyui_tasks
      WHERE projectId = ? AND targetType = 'shot' AND status IN ('pending', 'processing') AND workflowBatchId IS NOT NULL
      LIMIT 1
    `).get(projectId) as { workflowBatchId: string } | undefined;

    if (activeBatchTask) {
      console.log(`[Generate All] Found existing active batch ${activeBatchTask.workflowBatchId} for project ${projectId}.`);
      return res.json({
        success: true,
        workflowBatchId: activeBatchTask.workflowBatchId,
        message: 'Batch already running',
        count: 0
      });
    }

    const script = getGeneratedScript(String(projectId));
    if (!script) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const mode = regenerateMode || 'missing'; // 'all', 'missing', 'failed'
    const shots = script.newShots || [];

    const selectedShots = shots.map((shot: any, idx: number) => ({ shot, idx })).filter(({ shot, idx }: any) => {
      const latestTask = dbSqlite.prepare(`SELECT status, imageUrl FROM comfyui_tasks WHERE projectId = ? AND targetId = ? AND viewType = 'main' ORDER BY createdAt DESC LIMIT 1`).get(projectId, shot.id) as any;
      if (mode === 'all') return true;
      if (mode === 'failed') return !!latestTask && ['failed', 'cancelled'].includes(latestTask.status);
      return !(latestTask?.status === 'succeeded' && latestTask.imageUrl && shot.imageUrl);
    });
    const preflightItems = selectedShots.map(({ shot, idx }: any) => {
      const characters = shotCharacters(String(projectId), idx, shot.description || '');
      const missing = characters.filter((character: any) => !character.avatarUrl);
      return { shotIndex: idx, targetId: shot.id, matchedCharacters: characters.map((c: any) => ({ id: c.id || null, name: c.name || null })), missingAvatar: missing.map((c: any) => c.name || c.id) };
    });
    const preflight = {
      total: preflightItems.length,
      pulid: preflightItems.filter(item => item.matchedCharacters.length > 0 && item.missingAvatar.length === 0).length,
      missingAvatar: preflightItems.filter(item => item.missingAvatar.length > 0).length,
      klein: preflightItems.filter(item => item.matchedCharacters.length === 0).length,
      items: preflightItems,
    };
    // Accepted production baseline: 10 shots in 7m35s = 45.5 seconds per shot.
    const averageSeconds = 455 / 10;
    const oldPendingCount = (dbSqlite.prepare(`SELECT COUNT(*) AS count FROM comfyui_tasks WHERE projectId = ? AND targetType = 'shot' AND status IN ('pending','processing')`).get(projectId) as any)?.count || 0;
    const suspiciousUnboundShots = preflightItems.filter(item => {
      const shot = shots[item.shotIndex];
      return item.matchedCharacters.length > 0 && (!Array.isArray(shot?.matchedCharacterIds) || shot.matchedCharacterIds.length === 0);
    }).map(item => ({ shotIndex: item.shotIndex, targetId: item.targetId, matchedCharacters: item.matchedCharacters }));
    Object.assign(preflight, {
      averageSecondsPerShot: averageSeconds,
      estimatedSeconds: Math.round(averageSeconds * (preflight.pulid + preflight.klein)),
      estimated60ShotSeconds: Math.round(averageSeconds * 60),
      requiresLargeBatchConfirmation: preflight.total > 30,
      hasPendingOldTasks: oldPendingCount > 0,
      pendingOldTaskCount: oldPendingCount,
      hasSuspiciousUnboundCharacterText: suspiciousUnboundShots.length > 0,
      suspiciousUnboundShots,
    });
    if (preflight.total === 0) return res.json({ success: true, requiresConfirmation: false, count: 0, message: 'No shots match the selected batch mode' });
    if (confirmed !== true) return res.json({ success: true, requiresConfirmation: true, preflight });
    const workflowBatchId = crypto.randomUUID();

    const tasksToCreate: any[] = [];
    let batchOrder = 0;

    const batchItems: any[] = [];
    for (const selected of selectedShots) {
      const { shot, idx } = selected;
      const targetId = shot.id;
      const viewType = 'main';

      // Check if there is already a pending task for this shot/main
      const pendingTask = dbSqlite.prepare(`
        SELECT id FROM comfyui_tasks
        WHERE projectId = ? AND targetId = ? AND viewType = ? AND status = 'pending'
        LIMIT 1
      `).get(projectId, targetId, viewType) as { id: string } | undefined;

      // "如果已有同项目 shot/main 的 pending 任务，默认跳过；除非 regenerateMode=all 且明确创建新版本。"
      if (pendingTask && mode !== 'all') {
        console.log(`[Generate All] Shot ${idx} (${targetId}) already has a pending task. Skipping.`);
        continue;
      }

      const preflightItem = preflightItems.find(item => item.shotIndex === idx)!;
      if (preflightItem.missingAvatar.length) {
        batchItems.push({ id: crypto.randomUUID(), targetId, shotIndex: idx, batchOrder: batchOrder++, taskId: null, matchedCharacters: preflightItem.matchedCharacters, workflowPresetId: '02_klein_pulid_identity', characterReferenceImageUrl: null, workflowInjected: 0, finalStatus: 'skipped_missing_avatar', error: `Missing Avatar: ${preflightItem.missingAvatar.join(', ')}` });
        continue;
      }

      // Reuse the existing single shot ComfyUI logic by calling prepareComfyTaskData
      // "失败的某个分镜不得阻塞后续分镜执行。"
      try {
        const prepared = await prepareComfyTaskData({
          projectId,
          targetType: 'shot',
          targetId,
          viewType,
          shotIndex: idx,
          prompt: shot.description || '',
          style: getStyleEnglishBackend(shot.style || '写实'),
          negativePrompt: undefined,
          seed: undefined,
          seedMode: 'random',
          lockCharacterIdentity: req.body.lockCharacterIdentity !== false,
          workflowBatchId
        });

        const taskId = crypto.randomUUID();
        tasksToCreate.push({
          ...prepared.taskData,
          id: taskId,
          batchOrder
        });
        batchItems.push({ id: crypto.randomUUID(), targetId, shotIndex: idx, batchOrder, taskId, matchedCharacters: preflightItem.matchedCharacters, workflowPresetId: prepared.taskData.workflowPresetId, characterReferenceImageUrl: prepared.taskData.characterReferenceImageUrl, workflowInjected: prepared.taskData.workflowPresetId === '02_klein_pulid_identity' && !!prepared.taskData.characterReferenceImageUrl ? 1 : 0, finalStatus: 'pending', error: null });
        batchOrder++;
      } catch (err: any) {
        console.error(`[Generate All] Failed to prepare task for shot ${idx} (${targetId}):`, err.message);
        batchItems.push({ id: crypto.randomUUID(), targetId, shotIndex: idx, batchOrder: batchOrder++, taskId: null, matchedCharacters: preflightItem.matchedCharacters, workflowPresetId: null, characterReferenceImageUrl: null, workflowInjected: 0, finalStatus: 'failed', error: err.message });
      }
    }

    // Insert all batch tasks in a single database transaction
    const tx = dbSqlite.transaction(() => {
      const now = new Date().toISOString();
      dbSqlite.prepare(`INSERT INTO comfyui_shot_batches (id, projectId, regenerateMode, status, totalCount, queuedCount, enqueueFailedCount, errorsJson, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        workflowBatchId, projectId, mode, tasksToCreate.length ? 'running' : 'completed', batchItems.length, tasksToCreate.length, batchItems.filter(item => item.finalStatus === 'failed').length, JSON.stringify(batchItems.filter(item => item.error).map(item => ({ shotIndex: item.shotIndex, error: item.error }))), now, now
      );
      const insertItem = dbSqlite.prepare(`INSERT INTO comfyui_shot_batch_items (id, batchId, projectId, targetId, shotIndex, batchOrder, taskId, matchedCharactersJson, workflowPresetId, characterReferenceImageUrl, workflowInjected, finalStatus, error, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const item of batchItems) insertItem.run(item.id, workflowBatchId, projectId, item.targetId, item.shotIndex, item.batchOrder, item.taskId, JSON.stringify(item.matchedCharacters), item.workflowPresetId, item.characterReferenceImageUrl, item.workflowInjected, item.finalStatus, item.error, now, now);
      for (const t of tasksToCreate) {
        // Cancel existing pending tasks for the same targetId and viewType (but NOT processing tasks!)
        dbSqlite.prepare(`
          UPDATE comfyui_tasks
          SET status = 'cancelled', supersededByTaskId = ?, error = 'Superseded by batch task', completedAt = ?, updatedAt = ?
          WHERE targetId = ? AND viewType = ? AND status = 'pending'
        `).run(t.id, new Date().toISOString(), new Date().toISOString(), t.targetId, t.viewType);

        dbSqlite.prepare(`
          INSERT INTO comfyui_tasks (
            id, projectId, targetId, targetType, viewType, shotIndex, characterName,
            prompt, negativePrompt, seed, model, width, height, status, retryCount,
            apiWorkflowJson, uiWorkflowJson, createdAt, updatedAt,
            workflowPresetId, workflowFamily, workflowBatchId, sourceImageUrl, sourceTaskId, outputNodeId, presetParametersJson,
            characterReferenceImageUrl, characterReferenceTaskId, lockCharacterIdentity, batchOrder
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          t.id,
          t.projectId,
          t.targetId,
          t.targetType,
          t.viewType,
          t.shotIndex,
          t.characterName,
          t.prompt,
          t.negativePrompt,
          t.seed,
          t.model,
          t.width,
          t.height,
          'pending',
          0,
          t.apiWorkflowJson,
          t.uiWorkflowJson,
          new Date().toISOString(),
          new Date().toISOString(),
          t.workflowPresetId,
          t.workflowFamily,
          t.workflowBatchId,
          t.sourceImageUrl,
          t.sourceTaskId,
          t.outputNodeId,
          t.presetParametersJson,
          t.characterReferenceImageUrl,
          t.characterReferenceTaskId,
          t.lockCharacterIdentity,
          t.batchOrder
        );
      }
    });
    tx();

    console.log(`[Generate All] Successfully enqueued batch ${workflowBatchId} with ${tasksToCreate.length} tasks.`);
    return res.json({
      success: true,
      workflowBatchId,
      count: tasksToCreate.length,
      preflight,
      summary: { total: batchItems.length, success: 0, failed: batchItems.filter(item => item.finalStatus === 'failed').length, skipped: batchItems.filter(item => item.finalStatus === 'skipped_missing_avatar').length },
      taskIds: tasksToCreate.map(t => t.id)
    });
  } catch (err: any) {
    console.error("[Generate All Endpoint Error]", err);
    return res.status(500).json({ error: err.message });
  }
});

function reportImagePath(imageUrl: string | null | undefined): string | null {
  if (!imageUrl || /^https?:\/\//i.test(imageUrl)) return null;
  const clean = imageUrl.split('?')[0].replace(/^\/+/, '');
  const resolved = clean.startsWith('uploads/')
    ? path.resolve(UPLOADS_DIR, clean.slice('uploads/'.length))
    : path.resolve(__dirname, clean);
  return resolved.startsWith(path.resolve(__dirname)) && fs.existsSync(resolved) ? resolved : null;
}

function escapeReportHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

app.post('/api/comfyui/shot-batches/:batchId/report', async (req, res) => {
  try {
    const batch = dbSqlite.prepare('SELECT * FROM comfyui_shot_batches WHERE id = ?').get(req.params.batchId) as any;
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const script = getGeneratedScript(batch.projectId);
    const rows = dbSqlite.prepare(`
      SELECT i.*, t.status AS taskStatus, t.imageUrl, t.model, t.workflowFamily, t.error AS taskError,
             t.createdAt AS taskCreatedAt, t.submittedAt, t.completedAt
      FROM comfyui_shot_batch_items i LEFT JOIN comfyui_tasks t ON t.id = i.taskId
      WHERE i.batchId = ? ORDER BY i.batchOrder
    `).all(batch.id) as any[];
    const items = rows.map(row => {
      const finalStatus = row.taskStatus === 'succeeded' ? 'success'
        : row.taskStatus === 'failed' || row.taskStatus === 'cancelled' ? 'failed'
          : row.finalStatus;
      return {
        shotIndex: row.shotIndex,
        targetId: row.targetId,
        matchedCharacters: JSON.parse(row.matchedCharactersJson || '[]'),
        workflowPresetId: row.workflowPresetId,
        model: row.model || null,
        characterReferenceImageUrl: row.characterReferenceImageUrl,
        workflowInjected: !!row.workflowInjected,
        finalStatus,
        imageUrl: row.imageUrl || null,
        error: row.taskError || row.error || null,
        durationSeconds: row.submittedAt && row.completedAt ? Math.max(0, Math.round((Date.parse(row.completedAt) - Date.parse(row.submittedAt)) / 1000)) : null,
      };
    });
    const summary = {
      total: items.length,
      success: items.filter(item => item.finalStatus === 'success').length,
      failed: items.filter(item => item.finalStatus === 'failed').length,
      skipped: items.filter(item => item.finalStatus === 'skipped_missing_avatar').length,
    };
    const relativeDir = path.join('reports', safePathSegment(batch.id, 'batch'));
    const outputDir = path.join(UPLOADS_DIR, relativeDir);
    fs.mkdirSync(outputDir, { recursive: true });
    const tileWidth = 320, tileHeight = 220, columns = Math.min(4, Math.max(1, items.length)), rowsCount = Math.max(1, Math.ceil(items.length / columns));
    const tiles = await Promise.all(items.map(async (item, index) => {
      const source = reportImagePath(item.imageUrl);
      const background = item.finalStatus === 'success' ? '#172033' : item.finalStatus === 'failed' ? '#451a1a' : '#3f2d12';
      const image = source
        ? await sharp(source).rotate().resize(tileWidth, tileHeight, { fit: 'cover' }).png().toBuffer()
        : await sharp({ create: { width: tileWidth, height: tileHeight, channels: 3, background } }).png().toBuffer();
      const characterNames = item.matchedCharacters.map((c: any) => c.name).filter(Boolean).join(', ') || '无角色';
      const taskShortId = String(rows[index]?.taskId || '-').slice(0, 8);
      const label = Buffer.from(`<svg width="${tileWidth}" height="${tileHeight}"><rect y="158" width="${tileWidth}" height="62" fill="rgba(0,0,0,.82)"/><text x="10" y="178" fill="white" font-size="14" font-family="sans-serif">镜头 ${item.shotIndex + 1} · ${escapeReportHtml(characterNames)}</text><text x="10" y="197" fill="#cbd5e1" font-size="10" font-family="sans-serif">${escapeReportHtml(item.workflowPresetId || 'no preset')}</text><text x="10" y="214" fill="#cbd5e1" font-size="10" font-family="sans-serif">task ${escapeReportHtml(taskShortId)} · injected ${item.workflowInjected}</text></svg>`);
      return sharp(image).composite([{ input: label }]).png().toBuffer();
    }));
    const contactSheetPath = path.join(outputDir, 'contact-sheet.png');
    await sharp({ create: { width: columns * tileWidth, height: rowsCount * tileHeight, channels: 3, background: '#0f172a' } })
      .composite(tiles.map((input, index) => ({ input, left: (index % columns) * tileWidth, top: Math.floor(index / columns) * tileHeight })))
      .png().toFile(contactSheetPath);
    const startedAt = rows.map(row => row.submittedAt || row.taskCreatedAt).filter(Boolean).sort()[0] || batch.createdAt;
    const completedAt = rows.map(row => row.completedAt).filter(Boolean).sort().at(-1) || batch.updatedAt;
    const durationSeconds = startedAt && completedAt ? Math.max(0, Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000)) : null;
    const reportItems = items.map((item, index) => ({
      shotIndex: item.shotIndex,
      status: item.finalStatus,
      skipReason: item.finalStatus === 'skipped_missing_avatar' ? item.error : null,
      taskId: rows[index]?.taskId || null,
      workflowPresetId: item.workflowPresetId,
      matchedCharacters: item.matchedCharacters,
      characterReferenceImageUrl: item.characterReferenceImageUrl,
      workflowInjected: item.workflowInjected,
      outputImageUrl: item.imageUrl,
      errorMessage: item.finalStatus === 'skipped_missing_avatar' ? null : item.error,
      model: item.model,
    }));
    const report = { batchId: batch.id, total: summary.total, succeeded: summary.success, failed: summary.failed, skipped: summary.skipped, duration: durationSeconds, startedAt, completedAt, generatedAt: new Date().toISOString(), projectId: batch.projectId, projectTitle: script?.title || script?.scriptTitle || script?.storyTitle || null, shots: reportItems };
    fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    const cards = reportItems.map(item => `<article><div class="thumb">${item.outputImageUrl ? `<img src="${escapeReportHtml(item.outputImageUrl)}">` : `<div class="placeholder">${escapeReportHtml(item.skipReason || item.errorMessage || item.status)}</div>`}</div><h3>镜头 ${item.shotIndex + 1} · ${escapeReportHtml(item.status)}</h3><p>角色：${escapeReportHtml(item.matchedCharacters.map((c: any) => c.name).join(', ') || '无角色')}</p><p>模型：${escapeReportHtml(item.model || '-')}</p><p>预设：${escapeReportHtml(item.workflowPresetId || '-')}</p><p>Task：<code>${escapeReportHtml(item.taskId || '-')}</code></p><p>Injected：${item.workflowInjected}</p></article>`).join('');
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>批次验收报告</title><style>body{font:14px system-ui;margin:32px;color:#e2e8f0;background:#0f172a}h1{margin-bottom:4px}.summary{display:flex;gap:24px;margin:20px 0}.sheet{max-width:100%;border:1px solid #475569}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-top:24px}article{background:#1e293b;border:1px solid #475569;border-radius:10px;padding:12px}.thumb{height:180px;background:#334155;display:flex;align-items:center;justify-content:center;overflow:hidden}.thumb img{width:100%;height:100%;object-fit:cover}.placeholder{color:#cbd5e1;padding:20px;text-align:center}p{margin:5px 0;color:#cbd5e1}code{font-size:11px}</style></head><body><h1>分镜批次验收报告</h1><div>项目：${escapeReportHtml(report.projectTitle || report.projectId)}　批次：${escapeReportHtml(batch.id)}</div><div class="summary"><b>总数 ${summary.total}</b><b>成功 ${summary.success}</b><b>失败 ${summary.failed}</b><b>跳过 ${summary.skipped}</b><b>耗时 ${escapeReportHtml(durationSeconds ?? '-')} 秒</b></div><img class="sheet" src="contact-sheet.png" alt="Contact sheet"><section class="grid">${cards}</section></body></html>`;
    fs.writeFileSync(path.join(outputDir, 'report.html'), html, 'utf8');
    fs.writeFileSync(path.join(outputDir, 'README.txt'), `批量验收报告\r\nBatch ID: ${batch.id}\r\n总数: ${summary.total}\r\n成功: ${summary.success}\r\n失败: ${summary.failed}\r\n跳过: ${summary.skipped}\r\n耗时: ${durationSeconds ?? '未知'} 秒\r\n\r\nreport.json 为机器可读明细；report.html 为可视化卡片报告；contact-sheet.png 为十宫格/批量视觉对比。\r\n`, 'utf8');
    const baseUrl = `/uploads/${relativeDir.replace(/\\/g, '/')}`;
    return res.json({ success: true, summary, reportJsonUrl: `${baseUrl}/report.json`, reportHtmlUrl: `${baseUrl}/report.html`, contactSheetUrl: `${baseUrl}/contact-sheet.png`, readmeUrl: `${baseUrl}/README.txt`, paths: [`${baseUrl}/report.json`, `${baseUrl}/report.html`, `${baseUrl}/contact-sheet.png`, `${baseUrl}/README.txt`] });
  } catch (error: any) {
    console.error('[Batch Report Error]', error);
    return res.status(500).json({ error: error.message || 'Failed to generate report' });
  }
});

app.post('/api/comfyui/shots/stop-generation', async (req, res) => {
  const { projectId, workflowBatchId } = req.body;
  if (!projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }

  try {
    let query = `
      UPDATE comfyui_tasks
      SET status = 'cancelled', completedAt = ?, updatedAt = ?, error = 'Stopped by user batch cancellation'
      WHERE projectId = ? AND status = 'pending' AND targetType = 'shot' AND viewType = 'main'
    `;
    const params = [new Date().toISOString(), new Date().toISOString(), projectId];

    if (workflowBatchId) {
      query += ` AND workflowBatchId = ?`;
      params.push(workflowBatchId);
    }

    const result = dbSqlite.prepare(query).run(...params);
    if (workflowBatchId) {
      dbSqlite.prepare(`UPDATE comfyui_shot_batch_items SET finalStatus = 'failed', error = 'Stopped by user', updatedAt = ? WHERE batchId = ? AND finalStatus IN ('pending','processing')`).run(new Date().toISOString(), workflowBatchId);
      dbSqlite.prepare(`UPDATE comfyui_shot_batches SET status = 'completed', stoppedAt = ?, updatedAt = ? WHERE id = ?`).run(new Date().toISOString(), new Date().toISOString(), workflowBatchId);
    }
    console.log(`[Stop Generation] Cancelled ${result.changes} pending shot tasks for project ${projectId}.`);
    return res.json({ success: true, cancelledCount: result.changes });
  } catch (err: any) {
    console.error("[Stop Generation Error]", err);
    return res.status(500).json({ error: err.message });
  }
});

// 11. POST /api/generate-image - Generate image using Pollinations AI, Kling AI, or local ComfyUI
function getGeneratedScript(projectId: string): any | null {
  try {
    const row = dbSqlite.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get() as { value: string } | undefined;
    if (!row) return null;
    const scripts = JSON.parse(row.value);
    return scripts.find((s: any) => String(s.id) === String(projectId)) || null;
  } catch (err) {
    console.error("[getGeneratedScript Error]", err);
    return null;
  }
}

function getCharacterAvatarUrl(projectId: string, targetId: string): string | null {
  try {
    const script = getGeneratedScript(projectId);
    if (!script) return null;
    const char = script.newCharacters?.find((c: any) => c.id === targetId || String(c.id) === String(targetId));
    return char?.avatarUrl || null;
  } catch (err) {
    console.error("[getCharacterAvatarUrl Error]", err);
    return null;
  }
}

function shotCharacters(projectId: string, shotIndex: number | undefined, prompt: string): any[] {
  const script = getGeneratedScript(projectId);
  if (!script) return [];
  const shot = typeof shotIndex === 'number' ? script.newShots?.[shotIndex] : null;
  const matchedCharacterIds = new Set(
    [...(shot?.matchedCharacterIds || [])]
      .map((value: any) => String(value).trim().toLocaleLowerCase())
      .filter(Boolean),
  );
  const legacyCharacterKeys = new Set(
    [...(shot?.characterIds || []), ...(shot?.characters || []), ...(shot?.characterNames || [])]
      .map((value: any) => String(value).trim().toLocaleLowerCase())
      .filter(Boolean),
  );
  const searchable = `${prompt || ''} ${shot?.description || ''}`.toLocaleLowerCase();
  const matchedCharacters = (script.newCharacters || []).filter((character: any) => {
    const id = String(character.id || '').trim().toLocaleLowerCase();
    if (matchedCharacterIds.size > 0) return id && matchedCharacterIds.has(id);
    return (id && legacyCharacterKeys.has(id)) || characterMatchTerms(character).some(term => (
      legacyCharacterKeys.has(term) || searchable.includes(term)
    ));
  });
  console.log('[CharacterConsistency:Detect]', JSON.stringify({
    projectId,
    shotIndex: typeof shotIndex === 'number' ? shotIndex : null,
    shotId: shot?.id || null,
    matchedCharacterIds: [...matchedCharacterIds],
    legacyCharacterKeys: [...legacyCharacterKeys],
    promptPreview: String(prompt || '').slice(0, 200),
    descriptionPreview: String(shot?.description || '').slice(0, 200),
    availableCharacters: (script.newCharacters || []).map((character: any) => ({
      id: character.id || null,
      name: character.name || null,
      avatarUrl: character.avatarUrl || null,
      frontUrl: character.views?.front || null,
      sideUrl: character.views?.side || null,
      backUrl: character.views?.back || null,
    })),
    matchedCharacters: matchedCharacters.map((character: any) => ({ id: character.id || null, name: character.name || null })),
  }));
  return matchedCharacters;
}

async function readCharacterReferenceImage(imageUrl: string): Promise<Buffer | null> {
  try {
    if (/^https?:\/\//i.test(imageUrl)) {
      const response = await fetch(imageUrl);
      if (!response.ok) return null;
      return Buffer.from(await response.arrayBuffer());
    }
    const clean = imageUrl.split('?')[0].replace(/^\/+/, '');
    const candidates = clean.startsWith('uploads/')
      ? [path.resolve(UPLOADS_DIR, clean.slice('uploads/'.length))]
      : [path.resolve(__dirname, clean), path.resolve(UPLOADS_DIR, clean)];
    const localPath = candidates.find(candidate => fs.existsSync(candidate));
    return localPath ? fs.readFileSync(localPath) : null;
  } catch (err) {
    console.warn(`[Character Consistency] Could not read reference '${imageUrl}':`, err);
    return null;
  }
}

async function createShotCharacterReference(
  projectId: string,
  shotIndex: number | undefined,
  prompt: string,
): Promise<{ sourceImageUrl: string | null; referenceTaskId: string | null; characters: any[]; warning?: string }> {
  const characters = shotCharacters(projectId, shotIndex, prompt);
  if (!characters.length) {
    console.warn('[CharacterConsistency:NoCharacterMatch]', JSON.stringify({ projectId, shotIndex: typeof shotIndex === 'number' ? shotIndex : null }));
    return { sourceImageUrl: null, referenceTaskId: null, characters: [] };
  }
  const missingAvatar = characters.find(character => !character.avatarUrl);
  if (missingAvatar) {
    return {
      sourceImageUrl: null,
      referenceTaskId: null,
      characters,
      warning: `角色“${missingAvatar.name}”尚无 Avatar。请先生成角色母版/参考图，再生成分镜。`,
    };
  }
  const sources = characters.flatMap(character => [
    character.avatarUrl, character.views?.front, character.views?.side, character.views?.back,
  ].filter(Boolean).map((url: string) => ({ character, url })));
  console.log('[CharacterConsistency:ReferenceSources]', JSON.stringify({
    projectId,
    shotIndex: typeof shotIndex === 'number' ? shotIndex : null,
    characterIds: characters.map(character => character.id || null),
    sources: sources.map(source => ({ characterId: source.character.id || null, characterName: source.character.name || null, url: source.url })),
  }));
  if (!sources.length) {
    return { sourceImageUrl: null, referenceTaskId: null, characters, warning: '镜头中的角色尚无 Avatar，当前预设无法锁定角色身份。' };
  }

  const tiles: Buffer[] = [];
  for (const source of sources) {
    const input = await readCharacterReferenceImage(source.url);
    console.log('[CharacterConsistency:ReferenceRead]', JSON.stringify({
      projectId,
      shotIndex: typeof shotIndex === 'number' ? shotIndex : null,
      characterId: source.character.id || null,
      url: source.url,
      loaded: !!input,
      bytes: input?.length || 0,
    }));
    if (input) tiles.push(await sharp(input).rotate().resize(512, 512, { fit: 'contain', background: '#ffffff' }).png().toBuffer());
  }
  if (!tiles.length) {
    return { sourceImageUrl: null, referenceTaskId: null, characters, warning: '角色参考图无法读取，当前预设无法锁定角色身份。' };
  }

  const columns = Math.min(4, tiles.length);
  const rows = Math.ceil(tiles.length / columns);
  const hash = crypto.createHash('sha256').update(sources.map(item => item.url).join('|')).digest('hex');
  const relativeDir = path.join('projects', safePathSegment(projectId, 'project'), 'character-references');
  const outputDir = path.join(UPLOADS_DIR, relativeDir);
  const outputPath = path.join(outputDir, `${hash}.png`);
  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(outputDir, { recursive: true });
    await sharp({ create: { width: columns * 512, height: rows * 512, channels: 3, background: '#ffffff' } })
      .composite(tiles.map((input, index) => ({ input, left: (index % columns) * 512, top: Math.floor(index / columns) * 512 })))
      .png().toFile(outputPath);
  }
  const primaryCharacter = characters[0];
  const referenceTask = dbSqlite.prepare(`
    SELECT id FROM comfyui_tasks
    WHERE projectId = ? AND targetId = ? AND targetType = 'character'
      AND viewType IN ('avatar', 'front') AND status = 'succeeded'
    ORDER BY completedAt DESC, createdAt DESC LIMIT 1
  `).get(projectId, String(primaryCharacter.id || '')) as { id: string } | undefined;
  const sourceImageUrl = `/uploads/${relativeDir.replace(/\\/g, '/')}/${hash}.png`;
  console.log('[CharacterConsistency:CompositeReady]', JSON.stringify({
    projectId,
    shotIndex: typeof shotIndex === 'number' ? shotIndex : null,
    characterIds: characters.map(character => character.id || null),
    tileCount: tiles.length,
    outputPath,
    sourceImageUrl,
    referenceTaskId: referenceTask?.id || null,
  }));
  return {
    sourceImageUrl,
    referenceTaskId: referenceTask?.id || null,
    characters,
  };
}

function applyPresetParameters(
  apiWorkflow: any,
  manifest: any,
  params: {
    prompt?: string;
    seed?: string;
    width?: number;
    height?: number;
    strength?: number;
    loraStrength?: number;
  }
) {
  const cloned = JSON.parse(JSON.stringify(apiWorkflow));
  const mappings = manifest.nodeMappings || {};

  if (params.prompt && mappings.promptNodeId && mappings.promptInputKey) {
    const node = cloned[mappings.promptNodeId];
    if (node && node.inputs) {
      if (Array.isArray(node.inputs[mappings.promptInputKey])) {
        const sourceNodeId = node.inputs[mappings.promptInputKey][0];
        const sourceNode = cloned[sourceNodeId];
        if (sourceNode && sourceNode.inputs) {
          sourceNode.inputs["value"] = params.prompt;
        }
      } else {
        node.inputs[mappings.promptInputKey] = params.prompt;
      }
    }
  }

  if (params.seed && mappings.seedNodeId && mappings.seedInputKey) {
    const node = cloned[mappings.seedNodeId];
    if (node && node.inputs) {
      node.inputs[mappings.seedInputKey] = Number(params.seed) || params.seed;
    }
  }

  if (params.width && mappings.widthNodeId && mappings.widthInputKey) {
    const node = cloned[mappings.widthNodeId];
    if (node && node.inputs) {
      node.inputs[mappings.widthInputKey] = Number(params.width) || params.width;
    }
  }

  if (params.height && mappings.heightNodeId && mappings.heightInputKey) {
    const node = cloned[mappings.heightNodeId];
    if (node && node.inputs) {
      node.inputs[mappings.heightInputKey] = Number(params.height) || params.height;
    }
  }

  if (params.strength !== undefined && mappings.strengthNodeId && mappings.strengthInputKey) {
    const node = cloned[mappings.strengthNodeId];
    if (node && node.inputs) {
      node.inputs[mappings.strengthInputKey] = Number(params.strength) || params.strength;
    }
  }

  if (params.loraStrength !== undefined && mappings.loraStrengthNodeId && mappings.loraStrengthInputKey) {
    const node = cloned[mappings.loraStrengthNodeId];
    if (node && node.inputs) {
      node.inputs[mappings.loraStrengthInputKey] = Number(params.loraStrength) || params.loraStrength;
    }
  }

  return cloned;
}

function applyPresetUiParameters(
  uiWorkflow: any,
  manifest: any,
  params: {
    prompt?: string;
    negativePrompt?: string;
    seed?: string;
    width?: number;
    height?: number;
    model?: string;
  },
) {
  const cloned = JSON.parse(JSON.stringify(uiWorkflow));
  const mappings = presetParameterNodeIds(manifest);
  const setWidget = (key: PresetParameterKey, value: string | number | undefined) => {
    const nodeId = mappings[key];
    if (!nodeId || value === undefined) return;
    const node = mappedPresetUiNode(cloned, nodeId, key);
    if (!Array.isArray(node.widgets_values)) node.widgets_values = [];
    const widgetIndex = key === 'height' && mappings.width === mappings.height ? 1 : 0;
    node.widgets_values[widgetIndex] = key === 'seed' ? Number(value) || value : value;
  };

  setWidget('positivePrompt', params.prompt);
  setWidget('negativePrompt', params.negativePrompt);
  setWidget('seed', params.seed);
  setWidget('width', params.width);
  setWidget('height', params.height);
  setWidget('model', params.model);
  return cloned;
}

async function prepareComfyTaskData(reqBody: any) {
  const {
    prompt, style, isCharacter, skipTranslation, negativePrompt, negative_prompt, seed,
    projectId, targetType, shotIndex, characterName, targetId: reqTargetId, viewType: reqViewType,
    presetId: reqPresetId, workflowPresetId: reqWorkflowPresetId, presetRole: reqPresetRole,
    width: reqWidth, height: reqHeight, seedMode, lockCharacterIdentity: reqLockCharacterIdentity,
    workflowBatchId, strength: reqStrength, loraStrength: reqLoraStrength, model: reqModel
  } = reqBody;

  let optimizedPrompt = prompt || '';
  if (prompt && !skipTranslation) {
    optimizedPrompt = await optimizePrompt(prompt, !!isCharacter, style);
  } else if (prompt) {
    console.log(`[prepareComfyTaskData] Skipping translation. Using direct prompt: "${prompt}"`);
  }

  const targetId = reqTargetId || (targetType === 'shot' ? `shot_${shotIndex}` : `char_${characterName}`);
  const viewType = reqViewType || (targetType === 'shot' ? 'main' : 'avatar');
  const projectPreferences = projectComfyPreferences(String(projectId || ''));
  const hasExplicitPreset = reqPresetId !== undefined || reqWorkflowPresetId !== undefined;
  const explicitPreset = reqPresetId ?? reqWorkflowPresetId;
  const lockCharacterIdentity = targetType === 'shot' ? reqLockCharacterIdentity !== false : false;

  const characterReference = targetType === 'shot' && lockCharacterIdentity
    ? await createShotCharacterReference(String(projectId || ''), typeof shotIndex === 'number' ? shotIndex : undefined, String(prompt || ''))
    : { sourceImageUrl: null, referenceTaskId: null, characters: [] as any[], warning: undefined as string | undefined };

  if (targetType === 'shot') {
    console.log('[CharacterConsistency:Preflight]', JSON.stringify({
      projectId: String(projectId || ''),
      targetId,
      shotIndex: typeof shotIndex === 'number' ? shotIndex : null,
      lockCharacterIdentity,
      detectedCharacterIds: characterReference.characters.map((character: any) => character.id || null),
      detectedCharacterNames: characterReference.characters.map((character: any) => character.name || null),
      referenceImageUrl: characterReference.sourceImageUrl,
      referenceTaskId: characterReference.referenceTaskId,
      warning: characterReference.warning || null,
    }));
  }

  if (lockCharacterIdentity && characterReference.characters.length && !characterReference.sourceImageUrl) {
    throw new Error(characterReference.warning || '请先生成角色母版/参考图，再生成分镜。');
  }

  let selectedPreset: string;
  if (hasExplicitPreset) {
    selectedPreset = String(explicitPreset || 'sdxl_legacy');
  } else if (reqPresetRole === 'threeView') {
    selectedPreset = projectPreferences.threeViewPresetId;
  } else if (reqPresetRole === 'identity') {
    selectedPreset = projectPreferences.identityPresetId;
  } else if (reqPresetRole === 'upscale') {
    selectedPreset = projectPreferences.upscalePresetId;
  } else if (targetType === 'character') {
    selectedPreset = projectPreferences.characterMasterPresetId;
  } else {
    selectedPreset = projectPreferences.shotPresetId;
  }
  if (targetType === 'shot' && lockCharacterIdentity && characterReference.sourceImageUrl) {
    selectedPreset = projectPreferences.identityPresetId;
  }

  const resolvedWorkflowId = workflowIdForSelection(selectedPreset);
  if (resolvedWorkflowId === undefined) {
    throw new Error(`Unsupported workflow preset: ${selectedPreset}`);
  }
  const presetId = resolvedWorkflowId || undefined;
  if (targetType === 'shot') {
    console.log('[CharacterConsistency:PresetDecision]', JSON.stringify({
      projectId: String(projectId || ''),
      targetId,
      shotIndex: typeof shotIndex === 'number' ? shotIndex : null,
      projectShotPresetId: projectPreferences.shotPresetId,
      projectIdentityPresetId: projectPreferences.identityPresetId,
      selectedPreset,
      resolvedWorkflowPresetId: presetId || 'sdxl_legacy',
      usedIdentityPreset: !!characterReference.sourceImageUrl,
    }));
  }

  const requestedWidth = Number(reqWidth) || (isCharacter ? 512 : 768);
  const requestedHeight = Number(reqHeight) || (isCharacter ? 768 : 512);
  const width = Math.max(256, Math.min(2048, Math.floor(requestedWidth / 64) * 64));
  const height = Math.max(256, Math.min(2048, Math.floor(requestedHeight / 64) * 64));

  const taskSeed = (seedMode === 'random' || !seed)
    ? String(Number(BigInt(`0x${crypto.randomBytes(8).toString('hex')}`) % 9_007_199_254_740_991n))
    : String(seed);
  const comfyNegative = String(negativePrompt || negative_prompt || DEFAULT_COMFY_NEGATIVE_PROMPT);

  if (presetId) {
    const manifestPath = resolvePresetManifestPath(presetId);
    if (!manifestPath || !fs.existsSync(manifestPath)) {
      throw new Error(`Workflow preset manifest not found for: ${presetId}`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const sourceTaskId = reqBody.sourceTaskId || null;
    const sourceTask = sourceTaskId ? dbSqlite.prepare(`
      SELECT apiWorkflowJson, uiWorkflowJson FROM comfyui_tasks
      WHERE id = ? AND projectId = ? AND targetId = ? AND workflowPresetId = ? AND status = 'succeeded'
    `).get(sourceTaskId, String(projectId || ''), targetId, presetId) as any : null;
    let uiJson = JSON.parse(fs.readFileSync(path.join(path.dirname(manifestPath), manifest.uiFile), 'utf8'));
    let apiJson = JSON.parse(fs.readFileSync(path.join(path.dirname(manifestPath), manifest.apiFile), 'utf8'));
    if (sourceTask) {
      apiJson = JSON.parse(sourceTask.apiWorkflowJson);
      uiJson = JSON.parse(sourceTask.uiWorkflowJson);
    }
    const parameterNodeIds = validatePresetManifest(manifest, apiJson, uiJson, presetId);
    const presetNegative = parameterNodeIds.negativePrompt ? comfyNegative : '';

    let sourceImageUrl = characterReference.sourceImageUrl || reqBody.characterReferenceImageUrl || reqBody.sourceImageUrl || null;

    if (sourceImageUrl) validatePresetReferenceMapping(manifest, apiJson);

    if (presetId === '02_klein_pulid_identity' && !sourceImageUrl) {
      throw new Error("Reference image is required for PuLID identity lock.");
    }
    if (presetId === '04_esrgan_upscale' && !sourceImageUrl) {
      throw new Error("Source image is required for ESRGAN upscale.");
    }
    if (presetId === '03_qwen_2511_three_views') {
      const avatarUrl = getCharacterAvatarUrl(String(projectId || ''), targetId);
      if (!avatarUrl) {
        throw new Error("Character avatar is required as a reference to generate three views.");
      }
      sourceImageUrl = avatarUrl;
    }

    if (presetId === '03_qwen_2511_three_views' && targetType === 'shot') {
      throw new Error("Three views workflow is not supported for shot generation.");
    }

    const strength = reqStrength !== undefined ? Number(reqStrength) : manifest.defaultParameters?.strength;
    const loraStrength = reqLoraStrength !== undefined ? Number(reqLoraStrength) : manifest.defaultParameters?.loraStrength;

    const identityPrompt = characterReference.characters.length
      ? `IDENTITY PRIORITY: preserve the supplied character design exactly; do not redesign face, hair, clothing, colors, age, or body shape. ${characterReference.characters.map((character: any) => `${character.name}: ${character.clothing || character.role || ''}`).join('; ')}. SHOT: ${optimizedPrompt}`
      : optimizedPrompt;
    const apiSnapshot = applyPresetParameters(apiJson, manifest, {
      prompt: identityPrompt,
      seed: taskSeed,
      width,
      height,
      strength,
      loraStrength
    });
    const mappedModelNode = parameterNodeIds.model ? apiJson[parameterNodeIds.model] : null;
    const presetModel = mappedModelNode ? presetModelValue(mappedModelNode) : (manifest.requiredModels?.[0] || 'preset_model');
    if (targetType === 'shot') {
      console.log('[CharacterConsistency:TaskSnapshot]', JSON.stringify({
        projectId: String(projectId || ''),
        targetId,
        shotIndex: typeof shotIndex === 'number' ? shotIndex : null,
        workflowPresetId: presetId,
        workflowFamily: manifest.workflowFamily,
        model: presetModel,
        sourceImageUrl,
        referenceMappingValidated: !!sourceImageUrl,
      }));
    }
    const uiSnapshot = applyPresetUiParameters(uiJson, manifest, {
      prompt: identityPrompt,
      negativePrompt: presetNegative,
      seed: taskSeed,
      width,
      height,
      model: presetModel,
    });

    return {
      success: true,
      presetId,
      taskData: {
        projectId: String(projectId || ''),
        targetId,
        targetType: targetType || (isCharacter ? 'character' : 'shot'),
        viewType,
        shotIndex: typeof shotIndex === 'number' ? shotIndex : null,
        characterName: characterName ? String(characterName) : null,
        prompt: identityPrompt,
        negativePrompt: presetNegative,
        seed: taskSeed,
        model: presetModel,
        width,
        height,
        apiWorkflowJson: JSON.stringify(apiSnapshot),
        uiWorkflowJson: JSON.stringify(uiSnapshot),
        workflowPresetId: presetId,
        workflowFamily: manifest.workflowFamily,
        workflowBatchId: workflowBatchId || null,
        sourceImageUrl,
        sourceTaskId,
        outputNodeId: manifest.nodeMappings?.saveImageNodeId || '9',
        presetParametersJson: JSON.stringify({ strength, loraStrength }),
        characterReferenceImageUrl: characterReference.sourceImageUrl,
        characterReferenceTaskId: characterReference.referenceTaskId,
        lockCharacterIdentity: lockCharacterIdentity ? 1 : 0
      },
      warning: characterReference.warning || (
        characterReference.characters.length && presetId !== '02_klein_pulid_identity'
          ? '当前分镜预设不支持参考图身份锁定；已保留文本提示，但角色外观可能漂移。'
          : undefined
      )
    };
  }

  // Custom workflow path
  const customWorkflow = loadCustomComfyWorkflow();
  let checkpoint = '';
  if (!customWorkflow) {
    const available = await getComfyCheckpointsList();
    if (reqModel) {
      if (available.length > 0 && !available.includes(reqModel)) {
        throw new Error(`Model '${reqModel}' is not available in ComfyUI checkpoints.`);
      }
      checkpoint = reqModel;
    } else {
      checkpoint = await getComfyCheckpoint();
    }
  }

  const workflowSnapshot = customWorkflow
    ? applyCustomComfyInputs(customWorkflow, optimizedPrompt, comfyNegative, width, height, taskSeed)
    : buildDefaultComfyWorkflow(checkpoint, optimizedPrompt, comfyNegative, width, height, taskSeed);

  let apiWorkflowJson = '';
  let uiWorkflowJson = '';
  if (customWorkflow) {
    apiWorkflowJson = JSON.stringify(workflowSnapshot);
    uiWorkflowJson = '';
  } else {
    apiWorkflowJson = JSON.stringify(workflowSnapshot);
    const uiWorkflow = buildDefaultUIWorkflow(checkpoint, optimizedPrompt, comfyNegative, width, height, taskSeed);
    uiWorkflowJson = JSON.stringify(uiWorkflow);
  }
  const model = checkpoint || workflowCheckpoint(workflowSnapshot);

  return {
    success: true,
    presetId: 'sdxl_legacy',
    taskData: {
      projectId: String(projectId || ''),
      targetId,
      targetType: targetType || (isCharacter ? 'character' : 'shot'),
      viewType,
      shotIndex: typeof shotIndex === 'number' ? shotIndex : null,
      characterName: characterName ? String(characterName) : null,
      prompt: optimizedPrompt,
      negativePrompt: comfyNegative,
      seed: taskSeed,
      model,
      width,
      height,
      apiWorkflowJson,
      uiWorkflowJson,
      workflowPresetId: 'sdxl_legacy',
      workflowFamily: 'sdxl',
      workflowBatchId: workflowBatchId || null,
      sourceImageUrl: null,
      sourceTaskId: null,
      outputNodeId: '9',
      presetParametersJson: JSON.stringify({}),
      characterReferenceImageUrl: null,
      characterReferenceTaskId: null,
      lockCharacterIdentity: lockCharacterIdentity ? 1 : 0
    },
    warning: characterReference.characters.length
      ? '当前 SDXL Legacy 分镜预设不支持参考图身份锁定；已继续使用旧流程，角色外观可能漂移。'
      : undefined
  };
}

// 11. POST /api/generate-image - Generate image using Pollinations AI, Kling AI, or local ComfyUI
app.post('/api/generate-image', async (req, res) => {
  const {
    prompt, style, isCharacter, skipTranslation, platform, negativePrompt, negative_prompt, seed,
    projectId, targetType, shotIndex, characterName,
  } = req.body;

  if (!prompt && !req.body.presetId && !req.body.workflowPresetId && !req.body.presetRole) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  try {
    let optimizedPrompt = prompt || '';
    if (prompt && !skipTranslation) {
      optimizedPrompt = await optimizePrompt(prompt, !!isCharacter, style);
    } else if (prompt) {
      console.log(`[Generate Image] Skipping translation. Using direct prompt: "${prompt}"`);
    }

    if (platform === 'comfyui') {
      const targetId = req.body.targetId || (targetType === 'shot' ? `shot_${shotIndex}` : `char_${characterName}`);
      const viewType = req.body.viewType || (targetType === 'shot' ? 'main' : 'avatar');
      if (targetType === 'shot') {
        const script = getGeneratedScript(String(projectId || ''));
        const shot = script?.newShots?.find((item: any) => String(item.id) === String(targetId));
        console.log('[RegenerateWithReference:Start]', JSON.stringify({ taskId: null, shotId: targetId, projectId: String(projectId || ''), matchedCharacterIds: shot?.matchedCharacterIds || [], presetId: req.body.presetId || req.body.workflowPresetId || null, prompt_id: null, status: 'request_received', error: null }));
      }
      
      const existingActiveTask = dbSqlite.prepare(`
        SELECT id,status,workflowPresetId,characterReferenceImageUrl FROM comfyui_tasks
        WHERE projectId = ? AND targetId = ? AND viewType = ? AND status IN ('pending', 'processing')
        LIMIT 1
      `).get(String(projectId || ''), targetId, viewType) as any;

      if (existingActiveTask) {
        console.log(`[Generate Image] Found existing active task ${existingActiveTask.id} for slot ${targetId}:${viewType}. Rejecting duplicate.`);
        return res.status(409).json({ error: '已有任务进行中', existingTaskId: existingActiveTask.id, task: existingActiveTask, action: 'cancel_then_retry' });
      }

      try {
        await comfyFetch('/system_stats', {}, 3_000);
      } catch (error: any) {
        const message = `ComfyUI 未连接：${error.message || 'connection failed'}`;
        console.error('[TaskState:Failed]', JSON.stringify({ taskId: null, shotId: targetId, presetId: req.body.presetId || null, prompt_id: null, status: 'failed', error: message }));
        return res.status(503).json({ error: message, code: 'COMFYUI_UNAVAILABLE' });
      }

      const projectPreferences = projectComfyPreferences(String(projectId || ''));
      const hasExplicitPreset = Object.prototype.hasOwnProperty.call(req.body, 'presetId')
        || Object.prototype.hasOwnProperty.call(req.body, 'workflowPresetId');
      const explicitPreset = req.body.presetId ?? req.body.workflowPresetId;
      let selectedPreset: string;
      if (hasExplicitPreset) {
        selectedPreset = String(explicitPreset || 'sdxl_legacy');
      } else if (req.body.presetRole === 'threeView') {
        selectedPreset = projectPreferences.threeViewPresetId;
      } else if (req.body.presetRole === 'identity') {
        selectedPreset = projectPreferences.identityPresetId;
      } else if (req.body.presetRole === 'upscale') {
        selectedPreset = projectPreferences.upscalePresetId;
      } else if (targetType === 'character') {
        selectedPreset = projectPreferences.characterMasterPresetId;
      } else {
        selectedPreset = projectPreferences.shotPresetId;
      }
      
      const lockCharacterIdentity = targetType === 'shot' ? req.body.lockCharacterIdentity !== false : false;
      const characterReference = targetType === 'shot' && lockCharacterIdentity
        ? await createShotCharacterReference(String(projectId || ''), typeof shotIndex === 'number' ? shotIndex : undefined, String(prompt || ''))
        : { sourceImageUrl: null, referenceTaskId: null, characters: [] as any[], warning: undefined as string | undefined };
      
      if (targetType === 'shot' && lockCharacterIdentity && characterReference.sourceImageUrl) {
        selectedPreset = projectPreferences.identityPresetId;
      }

      const resolvedWorkflowId = workflowIdForSelection(selectedPreset);
      if (resolvedWorkflowId === undefined) return res.status(422).json({ error: `Unsupported workflow preset: ${selectedPreset}` });
      const presetId = resolvedWorkflowId || undefined;

      // Handle Qwen Three Views batch task manually as it creates 3 tasks
      if (presetId === '03_qwen_2511_three_views' && !req.body.sequentialThreeView) {
        const workflowBatchId = crypto.randomUUID();
        const allViewPrompts = [
          { view: 'front', prompt: '<sks> front view eye-level shot medium shot' },
          { view: 'side', prompt: '<sks> right side view eye-level shot medium shot' },
          { view: 'back', prompt: '<sks> back view eye-level shot medium shot' }
        ];
        const requestedSequentialView = req.body.sequentialThreeView
          && ['front', 'side', 'back'].includes(String(viewType))
          ? String(viewType)
          : null;
        const viewPrompts = requestedSequentialView
          ? allViewPrompts.filter(item => item.view === requestedSequentialView)
          : allViewPrompts;

        const taskIds: string[] = [];
        const taskSeed = (req.body.seedMode === 'random' || !seed)
          ? String(Number(BigInt(`0x${crypto.randomBytes(8).toString('hex')}`) % 9_007_199_254_740_991n))
          : String(seed);
        const comfyNegative = String(negativePrompt || negative_prompt || DEFAULT_COMFY_NEGATIVE_PROMPT);

        const manifestPath = resolvePresetManifestPath(presetId);
        if (!manifestPath || !fs.existsSync(manifestPath)) {
          return res.status(400).json({ error: `Workflow preset manifest not found for: ${presetId}` });
        }
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        let uiJson = JSON.parse(fs.readFileSync(path.join(path.dirname(manifestPath), manifest.uiFile), 'utf8'));
        let apiJson = JSON.parse(fs.readFileSync(path.join(path.dirname(manifestPath), manifest.apiFile), 'utf8'));
        
        const parameterNodeIds = validatePresetManifest(manifest, apiJson, uiJson, presetId);
        const presetNegative = parameterNodeIds.negativePrompt ? comfyNegative : '';
        
        let sourceImageUrl = characterReference.sourceImageUrl || req.body.characterReferenceImageUrl || req.body.sourceImageUrl || null;
        if (!sourceImageUrl) {
          return res.status(422).json({ error: '请先生成角色母版；三视图必须使用 avatar 作为 reference。' });
        }
        validatePresetReferenceMapping(manifest, apiJson);
        const avatarTask = dbSqlite.prepare(`
          SELECT id FROM comfyui_tasks
          WHERE projectId = ? AND targetId = ? AND targetType = 'character' AND viewType = 'avatar' AND status = 'succeeded'
          ORDER BY completedAt DESC, createdAt DESC LIMIT 1
        `).get(String(projectId || ''), targetId) as { id: string } | undefined;
        const sourceTaskId = req.body.sourceTaskId || avatarTask?.id || null;

        const tx = dbSqlite.transaction(() => {
          for (const vp of viewPrompts) {
            const taskId = crypto.randomUUID();
            taskIds.push(taskId);

            dbSqlite.prepare(`
              UPDATE comfyui_tasks
              SET status = 'cancelled', supersededByTaskId = ?, error = 'Superseded by batch task', completedAt = ?, updatedAt = ?
              WHERE targetId = ? AND viewType = ? AND status IN ('pending', 'processing')
            `).run(taskId, new Date().toISOString(), new Date().toISOString(), targetId, vp.view);

            const apiSnapshot = applyPresetParameters(apiJson, manifest, {
              prompt: vp.prompt,
              seed: taskSeed,
              loraStrength: 1.0
            });
            const uiSnapshot = applyPresetUiParameters(uiJson, manifest, {
              prompt: vp.prompt,
              negativePrompt: presetNegative,
              seed: taskSeed,
              model: manifest.requiredModels?.[0],
            });

            dbSqlite.prepare(`
              INSERT INTO comfyui_tasks (
                id, projectId, targetId, targetType, viewType, shotIndex, characterName,
                prompt, negativePrompt, seed, model, width, height, status, retryCount,
                apiWorkflowJson, uiWorkflowJson, createdAt, updatedAt,
                workflowPresetId, workflowFamily, workflowBatchId, sourceImageUrl, sourceTaskId, outputNodeId, presetParametersJson
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              taskId,
              String(projectId || ''),
              targetId,
              'character',
              vp.view,
              null,
              characterName ? String(characterName) : null,
              vp.prompt,
              presetNegative,
              taskSeed,
              'qwen_image_edit_2511_fp8_e4m3fn.safetensors',
              1024,
              1024,
              'pending',
              0,
              JSON.stringify(apiSnapshot),
              JSON.stringify(uiSnapshot),
              new Date().toISOString(),
              new Date().toISOString(),
              presetId,
              manifest.workflowFamily,
              workflowBatchId,
              sourceImageUrl,
              sourceTaskId,
              manifest.nodeMappings?.saveImageNodeId || '9',
              JSON.stringify({ loraStrength: 1.0 })
            );
          }
        });
        tx();

        console.log(`[Queue] Enqueued ${requestedSequentialView || 'batch'} task(s) for Qwen Three Views: ${taskIds.join(', ')}`);
        return res.json({
          success: true,
          batchId: workflowBatchId,
          taskIds,
          taskId: taskIds[0],
          status: 'pending',
          provider: 'comfyui',
          workflowPresetId: presetId,
        });
      } else {
        const taskId = crypto.randomUUID();
        const prepared = await prepareComfyTaskData(req.body);

        const tx = dbSqlite.transaction(() => {
          dbSqlite.prepare(`
            UPDATE comfyui_tasks
            SET status = 'cancelled', supersededByTaskId = ?, error = 'Superseded by new task', completedAt = ?, updatedAt = ?
            WHERE targetId = ? AND viewType = ? AND status IN ('pending', 'processing')
          `).run(taskId, new Date().toISOString(), new Date().toISOString(), prepared.taskData.targetId, prepared.taskData.viewType);

          dbSqlite.prepare(`
            INSERT INTO comfyui_tasks (
              id, projectId, targetId, targetType, viewType, shotIndex, characterName,
              prompt, negativePrompt, seed, model, width, height, status, retryCount,
              apiWorkflowJson, uiWorkflowJson, createdAt, updatedAt,
              workflowPresetId, workflowFamily, workflowBatchId, sourceImageUrl, sourceTaskId, outputNodeId, presetParametersJson,
              characterReferenceImageUrl, characterReferenceTaskId, lockCharacterIdentity
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            taskId,
            prepared.taskData.projectId,
            prepared.taskData.targetId,
            prepared.taskData.targetType,
            prepared.taskData.viewType,
            prepared.taskData.shotIndex,
            prepared.taskData.characterName,
            prepared.taskData.prompt,
            prepared.taskData.negativePrompt,
            prepared.taskData.seed,
            prepared.taskData.model,
            prepared.taskData.width,
            prepared.taskData.height,
            'pending',
            0,
            prepared.taskData.apiWorkflowJson,
            prepared.taskData.uiWorkflowJson,
            new Date().toISOString(),
            new Date().toISOString(),
            prepared.taskData.workflowPresetId,
            prepared.taskData.workflowFamily,
            prepared.taskData.workflowBatchId,
            prepared.taskData.sourceImageUrl,
            prepared.taskData.sourceTaskId,
            prepared.taskData.outputNodeId,
            prepared.taskData.presetParametersJson,
            prepared.taskData.characterReferenceImageUrl,
            prepared.taskData.characterReferenceTaskId,
            prepared.taskData.lockCharacterIdentity
          );
        });
        tx();

        console.log(`[Queue] Enqueued preset/custom task ${taskId} for ${prepared.taskData.targetId}:${prepared.taskData.viewType}`);
        if (prepared.taskData.targetType === 'shot') {
          console.log('[RegenerateWithReference:Start]', JSON.stringify({ taskId, shotId: prepared.taskData.targetId, projectId: prepared.taskData.projectId, matchedCharacterIds: shotCharacters(prepared.taskData.projectId, prepared.taskData.shotIndex, prepared.taskData.prompt).map((character: any) => character.id), presetId: prepared.taskData.workflowPresetId, prompt_id: null, status: 'pending', characterReferenceImageUrl: prepared.taskData.characterReferenceImageUrl || null, error: null }));
        }
        return res.json({
          success: true,
          taskId,
          status: 'pending',
          provider: 'comfyui',
          workflowPresetId: prepared.taskData.workflowPresetId,
          seed: prepared.taskData.seed,
          width: prepared.taskData.width,
          height: prepared.taskData.height,
          characterConsistency: prepared.taskData.characterReferenceImageUrl ? 'pulid' : 'none',
          characterReferenceImageUrl: prepared.taskData.characterReferenceImageUrl,
          characterReferenceTaskId: prepared.taskData.characterReferenceTaskId,
          lockCharacterIdentity: prepared.taskData.lockCharacterIdentity === 1,
          characterConsistencyWarning: prepared.warning
        });
      }
    }

    const useKling = platform === 'kling';
    const apiKey = process.env.KLING_API_KEY;

    if (useKling && apiKey) {
      console.log(`[Kling T2I] Submitting image generation task to Kling with prompt: "${optimizedPrompt}"`);
      const apiEndpoint = 'https://api.klingai.com/v1/images/generations';
      const response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model_name: 'kling-v1',
          prompt: optimizedPrompt,
          n: 1,
          aspect_ratio: isCharacter ? '1:1' : '3:2'
        })
      });

      const result = await response.json();
      if (!response.ok || result.code !== 0) {
        throw new Error(result.message || `Kling Image API error (status ${response.status})`);
      }

      const taskId = result.data?.task_id;
      if (!taskId) {
        throw new Error('Kling Image API did not return a task_id');
      }

      console.log(`[Kling T2I] Image task created: ${taskId}, polling status...`);

      // Poll task status
      const pollInterval = 2000;
      const maxAttempts = 15; // Max 30 seconds
      let attempts = 0;
      let cdnImageUrl = '';
      let finalStatus = 'failed';

      while (attempts < maxAttempts) {
        attempts++;
        await new Promise(resolve => setTimeout(resolve, pollInterval));

        const statusEndpoint = `https://api.klingai.com/v1/tasks/${taskId}`;
        const statusRes = await fetch(statusEndpoint, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiKey}`
          }
        });

        const statusResult = await statusRes.json();
        if (statusRes.ok && statusResult.code === 0) {
          const taskData = statusResult.data;
          const currentStatus = taskData?.status || taskData?.task_status;
          console.log(`[Kling T2I] Task ${taskId} status: ${currentStatus}`);

          if (currentStatus === 'succeed') {
            cdnImageUrl = taskData.task_result?.images?.[0]?.url || taskData.url;
            finalStatus = 'succeed';
            break;
          } else if (currentStatus === 'failed') {
            throw new Error(taskData?.task_status_msg || 'Kling image generation task failed');
          }
        } else {
          console.warn(`[Kling T2I] Status check failed:`, statusResult);
        }
      }

      if (finalStatus !== 'succeed' || !cdnImageUrl) {
        throw new Error('Kling image generation timed out or returned no image URL');
      }

      console.log(`[Kling T2I] Succeeded! Downloading image locally...`);

      // Download the image locally to uploads/images/
      const imagesDir = path.join(UPLOADS_DIR, 'images');
      if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true });
      }

      // CONTENT HASH CACHING
      const hash = crypto.createHash('sha256').update(cdnImageUrl).digest('hex');
      const localImgPath = path.join(imagesDir, `${hash}.jpg`);
      const localUrl = `/uploads/images/${hash}.jpg`;

      if (!fs.existsSync(localImgPath)) {
        console.log(`[Kling T2I Cache Miss] Downloading image to cache: ${hash}.jpg`);
        const imgRes = await fetch(cdnImageUrl);
        if (!imgRes.ok) {
          throw new Error(`Failed to download Kling image from CDN (status ${imgRes.status})`);
        }
        const arrayBuffer = await imgRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        fs.writeFileSync(localImgPath, buffer);
      } else {
        console.log(`[Kling T2I Cache Hit] Image already exists in cache: ${hash}.jpg`);
      }

      console.log(`[Kling T2I] Saved to local URL: ${localUrl}`);
      return res.json({ url: localUrl, prompt: optimizedPrompt });
    }

    // Default Fallback to Pollinations AI
    const width = isCharacter ? 512 : 768;
    const height = isCharacter ? 768 : 512;
    // Replace slashes in prompt to avoid routing issues
    const cleanPrompt = optimizedPrompt.replace(/\//g, ', ');
    const promptParam = encodeURIComponent(cleanPrompt);
    const imageUrl = `/api/pollinations-proxy?prompt=${promptParam}&width=${width}&height=${height}`;
    console.log(`[Pollinations AI] Generated local proxy URL: "${imageUrl}"`);

    return res.json({ url: imageUrl, prompt: optimizedPrompt });

  } catch (err: any) {
    console.error('[Generate Image Error]', err);
    res.status(500).json({ error: err.message || 'Image generation failed.' });
  }
});

// If in production, serve the frontend dist folder
if (process.env.NODE_ENV === 'production') {
  const DIST_DIR = path.join(__dirname, 'dist');
  app.use(express.static(DIST_DIR));
  app.get('*', (req, res) => {
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

// Pre-initialize database / run migration immediately on startup
try {
  console.log('[SQLite] Initializing database and running migration check...');
  readDb();
  migrateDatabaseIds();
} catch (e) {
  console.error('[SQLite] Initialization failed:', e);
}

registerShotAnalysisModule(app, dbSqlite);

// Start Server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  if (process.env.DISABLE_COMFY_WORKER !== 'true') {
    startComfyWorker();
  }
});
