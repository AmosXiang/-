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

// Ensure directories exist
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Initialize SQLite Database
const dbSqlite = new Database(path.join(__dirname, 'db.sqlite'));
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
    updatedAt TEXT NOT NULL
  )
`);
dbSqlite.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON comfyui_tasks (status, createdAt)`);
dbSqlite.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project_updated ON comfyui_tasks (projectId, updatedAt)`);

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
if (!comfyTaskColumns.has('importSha256')) {
  dbSqlite.exec('ALTER TABLE comfyui_tasks ADD COLUMN importSha256 TEXT');
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
    const scriptRecord = {
      id: Date.now().toString(),
      templateId: templateId || 'demo',
      templateTitle: templateId === 'demo' ? 'æ¼”ç¤ºåˆ†é•œæ¨¡æ¿' : (db.videos.find((v: any) => v.id === templateId)?.title || 'æœªçŸ¥æ¨¡æ¿'),
      topic: topic,
      createdAt: new Date().toISOString(),
      newTitle: result.newTitle,
      newNarrative: result.newNarrative,
      newCharacters: result.newCharacters.map((c: any) => ({
        id: crypto.randomUUID(),
        ...c,
        avatarUrl: ''
      })),
      newShots: result.newShots.map((s: any) => ({
        id: crypto.randomUUID(),
        ...s,
        imageUrl: ''
      }))
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
    const list = [...db.generated_scripts].sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve generated scripts' });
  }
});

// 9. DELETE /api/generated-scripts/:id - Delete specific script record
app.delete('/api/generated-scripts/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let found = false;
    await mutateDb((db) => {
      const index = db.generated_scripts.findIndex((s: any) => s.id === id);
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
      
      // Escape text for drawtext
      const escapedText = escapeDrawtextText(shot.description || '');
      
      // Cross-platform font file path (PingFang for macOS, Microsoft YaHei for Windows, fall back to default for others)
      let fontfile = '/System/Library/Fonts/PingFang.ttc';
      if (process.platform === 'win32') {
        fontfile = 'C\\:/Windows/Fonts/msyh.ttc';
      }

      // Scale to 1280x720, apply transitions, and draw Chinese subtitle overlay
      const vfString = `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fade=t=in:st=0:d=0.5,fade=t=out:st=${duration - 0.5}:d=0.5,drawtext=fontfile='${fontfile}':text='${escapedText}':fontsize=24:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8:x=(w-text_w)/2:y=h-80`;
      
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
  | { status: 'processing' }
  | { status: 'network_error' }
  | { status: 'missing' }
> {
  try {
    // 1. Check history
    const historyRes = await comfyFetch(`/history/${promptId}`, {}, 5_000);
    const history = await historyRes.json();
    const record = history?.[promptId];
    if (record) {
      if (record.status?.status_str === 'error') {
        return { status: 'failed', error: comfyErrorMessage(record) };
      }
      const images: any[] = [];
      for (const output of Object.values(record.outputs || {}) as any[]) {
        for (const image of output?.images || []) {
          if (image?.filename) images.push(image);
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
    const inPending = pending.some((item: any) => item[1] === promptId);
    
    if (inRunning || inPending) {
      return { status: 'processing' };
    }

    // 3. Not in history and not in queue
    return { status: 'missing' };
  } catch (err: any) {
    const isNetwork = err.code === 'ECONNREFUSED' || err.message.includes('fetch');
    if (isNetwork) {
      return { status: 'network_error' };
    }
    return { status: 'failed', error: err.message || 'Unknown error' };
  }
}

async function pollActiveTasks() {
  const activeTasks = dbSqlite.prepare("SELECT * FROM comfyui_tasks WHERE status = 'processing'").all() as any[];
  for (const task of activeTasks) {
    try {
      const state = await checkComfyTaskState(task.id);
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
          const scriptIndex = db.generated_scripts.findIndex((s: any) => s.id === task.projectId);
          if (scriptIndex !== -1) {
            const script = db.generated_scripts[scriptIndex];
            if (task.targetType === 'shot') {
              const shot = script.newShots?.find((s: any) => s.id === task.targetId);
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
                  if (task.viewType === 'front') {
                    char.avatarUrl = imageUrl;
                  }
                } else {
                  char.avatarUrl = imageUrl;
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
        });

      } else if (state.status === 'processing') {
        // Reset missing counters if found active in ComfyUI queue
        if (task.missingSince || task.recoveryCheckCount > 0) {
          dbSqlite.prepare(`
            UPDATE comfyui_tasks SET missingSince = NULL, recoveryCheckCount = 0, updatedAt = ? WHERE id = ?
          `).run(new Date().toISOString(), task.id);
        }
      } else if (state.status === 'network_error') {
        // ComfyUI disconnected, do nothing (keep state)
        console.warn(`[Worker] ComfyUI disconnected. Keeping task ${task.id} in processing status.`);
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
          console.log(`[Worker] Task ${task.id} is confirmed lost after ${count} checks and ${elapsed}ms. Resetting to pending.`);
          dbSqlite.prepare(`
            UPDATE comfyui_tasks
            SET status = 'pending', missingSince = NULL, recoveryCheckCount = 0, error = 'ComfyUI task lost', updatedAt = ?
            WHERE id = ? AND status = 'processing'
          `).run(new Date().toISOString(), task.id);
        }
      } else if (state.status === 'failed') {
        console.log(`[Worker] Task ${task.id} failed in ComfyUI: ${state.error}`);
        dbSqlite.prepare(`
          UPDATE comfyui_tasks
          SET status = 'failed', error = ?, completedAt = ?, updatedAt = ?
          WHERE id = ? AND status = 'processing'
        `).run(state.error, new Date().toISOString(), new Date().toISOString(), task.id);
      }
    } catch (err: any) {
      console.error(`[Worker] Error checking state for task ${task.id}:`, err);
    }
  }
}

async function submitComfyTask(task: any) {
  try {
    let workflow: any;
    if (task.apiWorkflowJson) {
      try {
        workflow = JSON.parse(task.apiWorkflowJson);
      } catch (err) {
        console.warn(`[Worker] Failed to parse apiWorkflowJson for task ${task.id}, rebuilding...`);
      }
    }

    if (!workflow) {
      // Rebuild and immediately persist to SQLite for compatibility/frozen principle
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
      
    const clientId = crypto.randomUUID();
    
    console.log(`[Worker] Submitting workflow to ComfyUI for task ${task.id} with prompt: "${task.prompt.slice(0, 100)}..."`);
    
    const response = await comfyFetch('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId, prompt_id: task.id }),
    });
    
    const result: any = await response.json();
    if (!result?.prompt_id) {
      const detail = result?.error || result?.node_errors;
      throw new Error(`ComfyUI did not accept the workflow: ${JSON.stringify(detail).slice(0, 500)}`);
    }
    
    console.log(`[Worker] Task ${task.id} accepted by ComfyUI successfully.`);
  } catch (err: any) {
    console.error(`[Worker] Failed to submit task ${task.id} to ComfyUI:`, err.message);
    const isNetwork = err.code === 'ECONNREFUSED' || err.message.includes('fetch');
    if (isNetwork) {
      console.warn(`[Worker] Re-queuing task ${task.id} due to connection error.`);
      dbSqlite.prepare(`
        UPDATE comfyui_tasks SET status = 'pending', updatedAt = ? WHERE id = ?
      `).run(new Date().toISOString(), task.id);
    } else {
      dbSqlite.prepare(`
        UPDATE comfyui_tasks SET status = 'failed', error = ?, completedAt = ?, updatedAt = ? WHERE id = ?
      `).run(err.message, new Date().toISOString(), new Date().toISOString(), task.id);
    }
  }
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
            SET status = 'processing', submittedAt = ?, updatedAt = ?
            WHERE id = ? AND status = 'pending'
          `).run(new Date().toISOString(), new Date().toISOString(), nextTask.id);
          
          if (updateResult.changes === 1) {
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

// ComfyUI Tasks endpoints
const DEFAULT_PARAMETER_NODE_IDS = Object.freeze({
  positivePrompt: '2',
  negativePrompt: '3',
  sampler: '5',
  checkpoint: '1',
  latent: '4',
});

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_IMPORT_METADATA_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_CHUNK_BYTES = 8 * 1024 * 1024;

class ImportResultError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

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
  const identityFields = ['sourceTaskId', 'projectId', 'targetId', 'targetType', 'viewType'] as const;
  for (const field of identityFields) {
    if (String(provenance[field] ?? '') !== String(sourceTask[field] ?? (field === 'sourceTaskId' ? sourceTask.id : ''))) {
      const expected = field === 'sourceTaskId' ? sourceTask.id : sourceTask[field];
      if (String(provenance[field] ?? '') !== String(expected ?? '')) {
        throw new ImportResultError(422, `Workflow provenance '${field}' does not match the source task.`);
      }
    }
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
  return { apiWorkflow, uiWorkflow, prompt, negativePrompt, seed: String(seed), model, width, height };
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
  return { ...publicTask, hasUiWorkflow };
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
    const tasks = dbSqlite.prepare(`
      SELECT 
        id, projectId, targetId, targetType, viewType, shotIndex, characterName,
        prompt, negativePrompt, seed, model, width, height, status, retryCount,
        retryOfTaskId, supersededByTaskId, error, recoveryCheckCount, missingSince,
        origin, importedFromTaskId, importSha256, imageUrl,
        createdAt, submittedAt, completedAt, updatedAt,
        apiWorkflowJson, uiWorkflowJson
      FROM comfyui_tasks
      WHERE projectId = ?
      ORDER BY createdAt ASC
    `).all(projectId) as any[];

    const mapped = tasks.map(publicComfyTask);
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
          apiWorkflowJson, uiWorkflowJson, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        new Date().toISOString()
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
      SET status = 'cancelled', completedAt = ?, updatedAt = ?
      WHERE id = ?
    `).run(new Date().toISOString(), new Date().toISOString(), id);

    // Best-effort cancel on ComfyUI if task is processing
    if (task.status === 'processing') {
      console.log(`[Queue] Best-effort delete from ComfyUI queue for cancelled task ${id}`);
      comfyFetch('/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [id] })
      }).catch(err => {
        console.warn(`[Queue] Failed to delete task ${id} from ComfyUI queue:`, err.message);
      });
    }

    console.log(`[Queue] Cancelled task ${id} successfully.`);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 11. POST /api/generate-image - Generate image using Pollinations AI, Kling AI, or local ComfyUI
app.post('/api/generate-image', async (req, res) => {
  const {
    prompt, style, isCharacter, skipTranslation, platform, negativePrompt, negative_prompt, seed,
    projectId, targetType, shotIndex, characterName,
  } = req.body;
  
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  try {
    // 1. Translate and optimize prompt with Gemini if skipTranslation is not set
    let optimizedPrompt = prompt;
    if (!skipTranslation) {
      optimizedPrompt = await optimizePrompt(prompt, !!isCharacter, style);
    } else {
      console.log(`[Generate Image] Skipping translation. Using direct prompt: "${prompt}"`);
    }

    if (platform === 'comfyui') {
      const requestedWidth = Number(req.body.width) || (isCharacter ? 512 : 768);
      const requestedHeight = Number(req.body.height) || (isCharacter ? 768 : 512);
      const width = Math.max(256, Math.min(2048, Math.floor(requestedWidth / 64) * 64));
      const height = Math.max(256, Math.min(2048, Math.floor(requestedHeight / 64) * 64));
      
      const seedMode = req.body.seedMode;
      const taskSeed = (seedMode === 'random' || !seed)
        ? String(Number(BigInt(`0x${crypto.randomBytes(8).toString('hex')}`) % 9_007_199_254_740_991n))
        : String(seed);
      const comfyNegative = String(negativePrompt || negative_prompt || DEFAULT_COMFY_NEGATIVE_PROMPT);

      const targetId = req.body.targetId || (targetType === 'shot' ? `shot_${shotIndex}` : `char_${characterName}`);
      const viewType = req.body.viewType || (targetType === 'shot' ? 'main' : 'avatar');

      // Load template workflows for snapshotting
      const customWorkflow = loadCustomComfyWorkflow();
      
      let checkpoint = '';
      if (!customWorkflow) {
        const available = await getComfyCheckpointsList();
        if (req.body.model) {
          if (available.length > 0 && !available.includes(req.body.model)) {
            return res.status(400).json({ error: `Model '${req.body.model}' is not available in ComfyUI checkpoints.` });
          }
          checkpoint = req.body.model;
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
        uiWorkflowJson = ''; // Custom workflows have no UI template unless loaded as UI template (not supported yet)
      } else {
        apiWorkflowJson = JSON.stringify(workflowSnapshot);
        const uiWorkflow = buildDefaultUIWorkflow(checkpoint, optimizedPrompt, comfyNegative, width, height, taskSeed);
        uiWorkflowJson = JSON.stringify(uiWorkflow);
      }
      const model = checkpoint || workflowCheckpoint(workflowSnapshot);

      const taskId = crypto.randomUUID();

      // Run database transactions to insert new task AND cancel old tasks in same slot
      const tx = dbSqlite.transaction(() => {
        // Cancel existing pending or processing tasks for the same slot
        dbSqlite.prepare(`
          UPDATE comfyui_tasks
          SET status = 'cancelled', supersededByTaskId = ?, error = 'Superseded by new task', completedAt = ?, updatedAt = ?
          WHERE targetId = ? AND viewType = ? AND status IN ('pending', 'processing')
        `).run(taskId, new Date().toISOString(), new Date().toISOString(), targetId, viewType);

        // Insert new pending task
        dbSqlite.prepare(`
          INSERT INTO comfyui_tasks (
            id, projectId, targetId, targetType, viewType, shotIndex, characterName,
            prompt, negativePrompt, seed, model, width, height, status, retryCount,
            apiWorkflowJson, uiWorkflowJson, createdAt, updatedAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          taskId,
          String(projectId || ''),
          targetId,
          targetType || (isCharacter ? 'character' : 'shot'),
          viewType,
          typeof shotIndex === 'number' ? shotIndex : null,
          characterName ? String(characterName) : null,
          optimizedPrompt,
          comfyNegative,
          taskSeed,
          model,
          width,
          height,
          'pending',
          Number(req.body.retryCount) || 0,
          apiWorkflowJson,
          uiWorkflowJson,
          new Date().toISOString(),
          new Date().toISOString()
        );
      });
      tx();

      console.log(`[Queue] Enqueued ComfyUI task ${taskId} for target ${targetId} (${viewType})`);

      return res.json({
        success: true,
        taskId,
        status: 'pending',
        provider: 'comfyui',
        seed: taskSeed,
        width,
        height
      });
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

// Start Server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  startComfyWorker();
});
