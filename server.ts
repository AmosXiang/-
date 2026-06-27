import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { exec } from 'child_process';
import util from 'util';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import PQueue from 'p-queue';

const execPromise = util.promisify(exec);

dotenv.config();

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

// Concurrent write queue
const writeQueue = new PQueue({ concurrency: 1 });

async function mutateDb(mutator: (db: any) => void | Promise<void>) {
  return writeQueue.add(async () => {
    const db = readDb();
    await mutator(db);
    writeDb(db);
  });
}


// Middleware
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
    structure: "由三个主要空间（飞空舱舱、万米云空、异域雪山与深海糖果界）构成的四幕式时空穿梭结构，通过黑色漩涡传送门切换场景，表现小队从日常拌嘴到协同坠落、再到时空大反差环境滑稽自救，最终在远古遗迹废墟与异形怪兽决战的叙事起伏。",
    rhythm: "视听上，前段以舱内跟拍对话为主，利用快节奏日常拌嘴建立羁绊；中段自舱门大开转为高速自由落体的高空惊险俯仰跟拍与第一人称极速穿梭，音乐从欢快日常转为震撼恢弘；后半段以不同重力/物质环境（雪山滑雪、深海物质转化、糖果王国鲜艳波普、沙漠废墟决战）进行快速交叉剪辑和定格剪辑，产生极佳的荒诞爆笑与热血对抗的起伏落差。",
    climaxDesign: "爽点位置设置在：1. 少女帅气后仰跃下舱门的动作高潮；2. 两个大男人在雪崩中狼狈翻滚的滑稽搞笑冲突点；3. 穿越糖果界后的视觉与音响狂欢；4. 沙漠遗迹废墟顶端合力击杀超巨型异形领主时的热血爽感爆发点。"
  },
  characters: [
    { name: "神秘少女", role: "主角/领航者", personality: "果断、冷酷腹黑、拥有召唤传送门的特殊异能，喜欢吐槽和看戏", clothing: "黑发、高底长靴、蒸汽朋克风机械挂饰皮衣" },
    { name: "赫伯特教授", role: "知识担当/搞笑担当", personality: "自尊心极强、话痨、傲娇嘴硬、有恐高症且认死理", clothing: "金属框单片眼镜、复古呢子大衣、便携式气压罗盘" },
    { name: "巴扎尔 (Bearded Warrior)", role: "战力担当/市井调剂", personality: "豪爽不羁、神经粗大、野性求生欲极强、爱贪便宜的络腮胡战士", clothing: "兽皮护肩、磨损严重的黄铜半身胸甲、腰挂短柄斧" }
  ],
  shots: [
    { timestamp: "00:00 - 00:07", timeSeconds: 3, movement: "全景航拍转倾斜俯冲", composition: "对称构图及下三分法构图", emotion: "震撼、壮丽、充满冒险史诗感", description: "一艘巨大的蒸汽飞空艇在白云缭绕的崇山峻岭间飞行，随后镜头垂直向下，俯冲展现飞空艇的动力推进装置，奠定了影片宏大的奇幻工业世界观。" },
    { timestamp: "00:07 - 00:27", timeSeconds: 15, movement: "低角度脚步跟拍至舱内推轨", composition: "利用两侧金属阀门与舱壁形成汇聚线/框架构图", emotion: "神秘、沉闷、暗流涌动", description: "舱内昏暗且充满金属感，神秘的黑发少女在前方走，沉重的厚底长靴发出回音。同行的赫伯特教授正在激烈地抱怨因迷路耽误了十二分钟。" },
    { timestamp: "00:27 - 00:40", timeSeconds: 32, movement: "中景对话结合角色面部特写", composition: "黄金分割点构图，聚焦教授面部细节", emotion: "风趣、辩论气氛、日常拌嘴", description: "赫伯特教授嘴硬推眼镜，宣称自己的伪装计划完美无瑕。巴扎尔无情戳穿：你把伪造的单子交给了一个不识字、甚至把纸拿反了的守卫！" },
    { timestamp: "00:40 - 00:57", timeSeconds: 48, movement: "定机位双人特写", composition: "强烈的左右对比构图，一糙一雅形成心理落差", emotion: "荒诞喜感、嫌弃", description: "巴扎尔毫不在意地用手指挖起鼻孔，教授感到极大生理不适。质问他是否在用手指挖鼻子，巴扎尔反讽说难道应该用叉子，教授则要求他保持‘基本文明’。" },
    { timestamp: "00:57 - 01:13", timeSeconds: 65, movement: "通道透视拉推镜", composition: "三分法、通道透视，灯光摇曳", emotion: "诙谐、市井冒险气", description: "舱顶气阀喷出蒸汽，吊灯剧烈晃动。巴扎尔嬉皮笑脸说他在‘寻找宝藏’。教授吐槽‘在鼻子里？’巴扎尔回敬‘在里面找到的东西比你前三张地图还要多！’" },
    { timestamp: "01:13 - 01:31", timeSeconds: 80, movement: "高低位垂直跟拍", composition: "纵向垂直分割画面，少女沿梯子下行", emotion: "欢乐、相互吐槽、羁绊加深", description: "少女沿铁梯轻盈走下，教授继续输出：‘如果谁活得像野兽，绝对是你，还记得吃生肉那次吗？’巴扎尔不甘示弱：‘那是蛋白质！你只是嫉妒我能消化。’" },
    { timestamp: "01:31 - 01:56", timeSeconds: 105, movement: "第一人称开门到广角摇摄", composition: "框式逆光，地平线处于中下段，云海在阳光下波澜壮阔", emotion: "心旷神怡、波澜壮阔、危机临近", description: "少女利落拉开沉重舱门，狂风大作。外面是高达万米的高空云海，远处漂浮着一艘飞空帆船。少女回头抛下一句‘下去的时候尽量别叫’，十分挑衅。" },
    { timestamp: "01:56 - 02:07", timeSeconds: 118, movement: "高速自由落体跟拍", composition: "俯仰视差，少女居中，放射线流线线条", emotion: "惊险、狂放、自由感", description: "少女张开双臂，优雅地向云海仰面坠下，动作潇洒完美。巴扎尔在甲板边哈哈大笑赞叹‘这才是我欣赏的女人！’，并戏谑教授是不是恐高。" },
    { timestamp: "02:07 - 02:25", timeSeconds: 135, movement: "镜头急速推拉与搞笑定格", composition: "教授侧身近景，巴扎尔突然消失打破平衡", emotion: "滑稽、强作镇定、认命", description: "教授嘴硬：‘我只是在计算最佳降落角度！’巴扎尔大吼‘那你去算算这个吧！’说完后仰尖叫跳下。教授绝望自语‘我讨厌这个队伍’，也无奈跃下。" },
    { timestamp: "02:25 - 03:24", timeSeconds: 165, movement: "高空平行摇摆跟拍", composition: "并列飞行，风阻形变，背景是无际蔚蓝和白云", emotion: "极度亢奋、强烈的速度和失重冲击", description: "三人如同鸟儿般穿过云海。巴扎尔大吼‘这才是生活！’，并疯狂嘲笑脸色煞白、还在手忙脚乱强装‘一切尽在掌握’的教授。少女则在一旁优雅滑行。" },
    { timestamp: "03:24 - 03:39", timeSeconds: 210, movement: "特效穿越快摇", composition: "斜向对角线构图，洁白雪山与黑色风暴传送门对撞", emotion: "极速丝滑、环境异样的震撼", description: "少女在空中凭空召唤一个黑色漩涡传送门，穿过后瞬间落在一座巍峨的雪山上，她凭借重靴如同滑雪板一般在陡峭雪坡上极速画弧滑行。" },
    { timestamp: "03:39 - 03:55", timeSeconds: 228, movement: "动态剪辑对比", composition: "左半边少女轻灵滑行，右半边两人狼狈翻滚", emotion: "滑稽搞笑、惊险万分", description: "两个大男人从传送门滚落砸进雪堆，惨遭雪崩式翻滚。教授绝望惨叫‘这不叫减速！这只是换了个姿势往下掉！’，巴扎尔嘴硬‘总比走路强！’" }
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
    title: { type: 'STRING', description: '视频的标题/名称' },
    genre: { type: 'STRING', description: '视频的类型/流派，例如：剧情、科幻、悬疑、纪录片、广告等' },
    tags: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: '视频的标签，例如：紧张、唯美、快节奏、感人等'
    },
    shots: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          timestamp: { type: 'STRING', description: '镜头的时间戳范围，例如 00:00 - 00:05' },
          timeSeconds: { type: 'INTEGER', description: '该镜头在视频中开始的秒数' },
          movement: { type: 'STRING', description: '运镜方式，例如：固定镜头、全景跟拍、低角度手持等' },
          composition: { type: 'STRING', description: '画面构图，例如：三分法、中心构图、框架构图等' },
          emotion: { type: 'STRING', description: '镜头传达的情绪，例如：震撼、平静、神秘、滑稽等' },
          description: { type: 'STRING', description: '该镜头画面的具体内容和情节描述' }
        },
        required: ['timestamp', 'timeSeconds', 'movement', 'composition', 'emotion', 'description']
      }
    },
    characters: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: '角色姓名或代号/外观特征代称，例如：黑发少女、教授、高大守卫' },
          role: { type: 'STRING', description: '角色戏份或定位，例如：主角、反面人物、背景路人' },
          personality: { type: 'STRING', description: '角色性格特点描述' },
          clothing: { type: 'STRING', description: '角色的服装、服饰及外貌特征' }
        },
        required: ['name', 'role', 'personality', 'clothing']
      }
    },
    narrative: {
      type: 'OBJECT',
      properties: {
        structure: { type: 'STRING', description: '故事的三幕剧结构分析（如开端、高潮、结局）' },
        rhythm: { type: 'STRING', description: '视频整体的剪辑节奏、视听搭配与节奏起伏特点' },
        climaxDesign: { type: 'STRING', description: '分析故事的爽点位置、戏剧冲突高潮点以及是如何设计的' }
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

    let prompt = `你是一个专业的影视分析大师。请仔细观看这段视频，并输出一个详细的中文视频结构化分析报告。
请严格按照提供的 JSON Schema 输出，必须包含以下内容：
1. 镜头列表 (shots)：请以每个“物理剪辑点 (Cut Point / Edit Point)”为单位识别分镜，最小分析粒度为1秒。绝对不要合并内容相似或连续发生的相邻镜头。每一次画面切换/物理剪辑发生后，必须单独输出一条镜头记录。每个镜头需要包含时间范围（如 00:00 - 00:05，起止时间要精准对齐物理剪辑点）、该镜头在视频中开始的秒数 (timeSeconds, 整数，表示距视频开头的秒数)、运镜方式、画面构图、情绪基调以及具体的画面内容情节描述。
2. 人物画像 (characters)：如果视频中出现主要人物，请提取所有主要角色的姓名或外观代称、角色身份定位、性格特征、服装描述。若无角色或人物，可为空列表。
3. 叙事与爽点 (narrative)：深入分析故事的故事结构（如三幕剧结构）、剪辑与视听节奏特点、爽点设计与冲突爆点位置。

请确保分析细致入微、条理清晰，严格遵守物理剪辑分镜划分规则。`;

    if (shortDramaMode) {
      prompt += `\n特别注意：这是竖屏短剧，每3-5秒一个镜头，按台词停顿和情绪转折切分。`;
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
      genre: analysisResult.genre || '剧情',
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
  
  if (!topic) {
    return res.status(400).json({ error: '新故事主题/设定是必需的。' });
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
    
    let prompt = `你是一个业界顶级的影视金牌编剧和分镜导演。
现在，我们要以一个现有的视频分析数据作为“创意骨架与节奏模板”，为你指定的一个新故事设定创作一套全新且高质量的影视剧本、角色卡片和分镜脚本。

【新故事设定/主题】
${topic}

【模板视频数据】
1. 叙事节奏与爽点：
   - 三幕结构：${templateData.narrative.structure}
   - 视听节奏：${templateData.narrative.rhythm}
   - 爽点冲突设计：${templateData.narrative.climaxDesign || (templateData.narrative as any).climaxDesign}
2. 模板人物关系与定位：
   ${JSON.stringify(templateData.characters, null, 2)}
3. 模板分镜序列与运镜美学：
   ${JSON.stringify(templateData.shots.map(s => ({
     timestamp: s.timestamp,
     timeSeconds: s.timeSeconds,
     movement: s.movement,
     composition: s.composition,
     emotion: s.emotion,
     description: s.description
   })), null, 2)}

【创作要求】
1. **结构与运镜继承**：新剧本的分镜节奏、转折起伏和叙事阶段必须严格对应模板视频的分镜脉络！例如：如果模板视频在第1个分镜是“航拍展现宏大世界观”，那新故事的第1个分镜也应当是用宏大的运镜 and 画面构图展现你的新主题世界观；如果模板在某处发生了空间穿梭或狼狈滑倒的情节，新剧本也应当在对应镜头设计出相同张力节奏的事件。
2. **人物映射**：新故事中的主要角色和人物关系应当与模板中的性格特征形成鲜明映射（如：一个冷面领航者、一个傲娇学者、一个豪爽糙汉战士），但角色的名称、服饰装备、台词细节必须完全原创并对齐新的主题设定。
3. **内容高度原创**：镜头的情节说明、台词、情感变化必须生动有趣、符合你资深编剧的身份。禁止原样照抄模板中 steampunk/飞空艇/雪山等特有词汇，必须对齐新故事的主题设定进行深度创作。

请严格按照提供的 JSON Schema 输出中文分析结果。`;

    if (shortDramaMode) {
      prompt += `\n\n【短剧模式启用】\n重要要求：这是竖屏短剧，每3-5秒一个镜头，按台词停顿和情绪转折切分。`;
      console.log('[Script Generator] Short Drama Mode enabled for script writing prompt.');
    }

    const generatedScriptSchema = {
      type: 'OBJECT',
      properties: {
        newTitle: { type: 'STRING', description: '全新剧本的标题' },
        newNarrative: {
          type: 'OBJECT',
          properties: {
            structure: { type: 'STRING', description: '新剧本的三幕叙事结构设计（对照模板结构的起承转合）' },
            rhythm: { type: 'STRING', description: '新剧本的情节与动作节奏规划（对照模板的节奏特点）' },
            climaxDesign: { type: 'STRING', description: '新剧本的冲突爽点位置与爆发设计说明' }
          },
          required: ['structure', 'rhythm', 'climaxDesign']
        },
        newCharacters: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING', description: '新故事中的角色姓名或代称' },
              role: { type: 'STRING', description: '新角色定位（对应模板中某个人物的角色定位与冲突关系）' },
              personality: { type: 'STRING', description: '新角色的性格特征' },
              clothing: { type: 'STRING', description: '新角色的服装/服饰/外貌设定描述' }
            },
            required: ['name', 'role', 'personality', 'clothing']
          }
        },
        newShots: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              timestamp: { type: 'STRING', description: '镜头的模拟时间戳，如 00:00 - 00:05' },
              timeSeconds: { type: 'INTEGER', description: '镜头的开始秒数（整数）' },
              movement: { type: 'STRING', description: '该镜头的运镜方式，如全景跟拍、推轨特写等（需继承模板的镜头语言）' },
              composition: { type: 'STRING', description: '该镜头的画面构图方式，如三分法、框式构图等（需继承模板的构图美学）' },
              emotion: { type: 'STRING', description: '该镜头传达的情绪，如震撼、神秘、紧张等' },
              description: { type: 'STRING', description: '镜头下的具体情节动作描述、人物对话以及音效规划' }
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
      templateTitle: templateId === 'demo' ? '演示分镜模板' : (db.videos.find((v: any) => v.id === templateId)?.title || '未知模板'),
      topic: topic,
      createdAt: new Date().toISOString(),
      newTitle: result.newTitle,
      newNarrative: result.newNarrative,
      newCharacters: result.newCharacters.map((c: any) => ({
        ...c,
        avatarUrl: ''
      })),
      newShots: result.newShots.map((s: any) => ({
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
    const { shotIndex, characterName, imageUrl, views } = req.body;
    
    if (!imageUrl && !views) {
      return res.status(400).json({ error: 'imageUrl or views is required' });
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
          script.newShots[shotIndex].imageUrl = imageUrl;
          script.newShots[shotIndex].generatedImageUrl = imageUrl;
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

  const rawInput = `姓名: ${name}\n角色: ${role}\n外貌服饰: ${clothing}\n性格特质: ${personality}`;

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
    .replace(/:/g, '：') // Replace English colons with Chinese colons
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
        const generateCmd = `ffmpeg -f lavfi -i "mandelbrot=size=1280x720:rate=25" -t 4 -c:v libx264 -pix_fmt yuv420p -an -y "${mockTemplatePath}"`;
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
        const generateCmd = `ffmpeg -f lavfi -i "mandelbrot=size=1280x720:rate=25" -t 4 -c:v libx264 -pix_fmt yuv420p -an -y "${mockTemplatePath}"`;
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
      
      // Scale to 1280x720, apply transitions, and draw Chinese subtitle overlay
      const vfString = `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fade=t=in:st=0:d=0.5,fade=t=out:st=${duration - 0.5}:d=0.5,drawtext=fontfile='/System/Library/Fonts/PingFang.ttc':text='${escapedText}':fontsize=24:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8:x=(w-text_w)/2:y=h-80`;
      
      const localInputVideoPath = shot.videoUrl ? path.join(__dirname, shot.videoUrl.substring(1)) : '';
      const hasVideo = localInputVideoPath && fs.existsSync(localInputVideoPath);

      if (hasVideo) {
        console.log(`[Animatic] Compiling shot ${i + 1} using generated video clip: ${shot.videoUrl}`);
        const cmd = `ffmpeg -i "${localInputVideoPath}" -an -t ${duration} -vf "${vfString}" -c:v libx264 -pix_fmt yuv420p -y "${localVidPath}"`;
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
        const cmd = `ffmpeg -loop 1 -i "${localImgPath}" -t ${duration} -vf "${vfString}" -c:v libx264 -pix_fmt yuv420p -y "${localVidPath}"`;
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
    const concatCmd = `ffmpeg -f concat -safe 0 -i "${concatFilePath}" -c copy -y "${combinedVidPath}"`;
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
        const bgmCmd = `ffmpeg -i "${combinedVidPath}" -stream_loop -1 -i "${bgmPath}" -filter_complex "[1:a]afade=t=out:st=${totalDuration - 1.5}:d=1.5[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -shortest -y "${finalVidPath}"`;
        await execPromise(bgmCmd);
      } else {
        console.warn(`[Animatic] BGM file not found at ${bgmPath}, compiling without BGM`);
        fs.copyFileSync(combinedVidPath, finalVidPath);
      }
    } else {
      console.log(`[Animatic] Compiling with silent audio...`);
      const silentCmd = `ffmpeg -i "${combinedVidPath}" -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -c:v copy -c:a aac -shortest -y "${finalVidPath}"`;
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


// 11. POST /api/generate-image - Generate image using Pollinations AI or Kling AI
app.post('/api/generate-image', async (req, res) => {
  const { prompt, style, isCharacter, skipTranslation, platform } = req.body;
  
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
} catch (e) {
  console.error('[SQLite] Initialization failed:', e);
}

// Start Server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
