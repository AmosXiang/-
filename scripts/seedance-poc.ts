// Seedance 2.0 视频生成 POC(独立实验脚本,npx tsx 运行)。
//
// ⚠️ 状态(2026-07-08 封存):BLOCKED — HNLINK 网关租户授权未落地,所有 create 返回
//    403「模型未分配给当前租户」(计费前被拒,¥0 消耗)。诊断全过程与解锁条件见
//    docs/seedance-poc/POC-REPORT.md 第 3、8 节。
//
// 授权解锁后的恢复步骤(不要重新讨论方案):
//   1. 确认 .env 的 HNLINK_API_KEY(若运营方发了新 key 先换上);
//   2. npx tsx scripts/seedance-poc.ts --single
//      → 单次探路(shot a、纯文本、480p、9:16、4s)。仍 403 = 授权未落地;
//        创建成功则记录真实扣费,核对 ¥41.4 的计价单位(/次 还是 /M tokens)后
//        再由用户拍板剩余 5 次怎么跑。ref 模式暂缓(定妆图无公网 HTTPS 托管)。
//
// 当前通道:HNLINK 中转(token.hnlink.net,第三方,HTTP 明文)——标注"Seedance 原厂路径",
// 请求/响应按火山方舟官方形状(model + content 数组);计费为中转商口径,不代表官方价。
// 不接入 server.ts,不建表,不动现有模块。产物落 docs/seedance-poc/。
//
// 用法: npx tsx scripts/seedance-poc.ts [--dry] [--single] [--mode text|ref|both] [--res 480p|720p]
//   --dry    只打印请求体,不调用(零成本)
//   --single 只跑 shot a 的 text 模式一次(最低成本探路,用于实测单次扣费)
//   --res    默认 480p(¥20 余额预算内跑满 6 次的档位)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'docs', 'seedance-poc');
const VIDEO_DIR = path.join(OUT_DIR, 'videos');
const BASE = (process.env.HNLINK_BASE || 'http://token.hnlink.net/api/gateway').replace(/\/$/, '');
const API_KEY = (process.env.HNLINK_API_KEY || '').trim();
// 模型 ID 已探明:5 个变体里 seedance2.0/Seedance2.0/seedance-2.0/doubao-seedance-2.0
// 均 403 未分配租户,"Seedance 2.0"(带空格)400 未配置计费规则——文档标准名 seedance2.0
// 是正确 ID,阻断纯粹在租户授权(见 POC-REPORT.md 第 3 节)。保留发现式循环以防解锁后有变。
const MODEL_CANDIDATES = ['seedance2.0'];
// 分镜实际时长 2-3s,平台 duration 范围 4-15s(-1 自适应),统一钳制到最小值 4s(亦为最低成本档)
const SHOT_DURATION = 4;

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const SINGLE = args.includes('--single');
const MODE = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'both';
const RES = args.includes('--res') ? args[args.indexOf('--res') + 1] : '480p';
const RATIO = '9:16';

// --- 分镜 → 时序 prompt(设计与理由见 POC-REPORT.md;运镜单列显式指令便于客观核对)---
const MOVEMENT_MAP: Array<[RegExp, string]> = [
  [/平移跟随/, '镜头横向平移跟随主体移动'],
  [/向右平移/, '镜头向右平移'],
  [/向左平移/, '镜头向左平移'],
  [/跟踪镜头|跟拍/, '镜头持续跟踪主体运动(tracking shot)'],
  [/变焦|放大/, '并带有缓慢推近变焦'],
  [/俯视|俯拍/, '俯视机位'],
  [/环绕|旋转/, '镜头环绕主体'],
  [/固定镜头/, '固定机位,镜头不动'],
];
function movementInstruction(movement: string): string {
  const parts: string[] = [];
  for (const [rx, phrase] of MOVEMENT_MAP) if (rx.test(movement)) parts.push(phrase);
  return parts.length ? parts.join(',') : `镜头运动:${movement}`;
}
function buildPrompt(shot: { movement: string; composition: string; emotion: string; description: string }): string {
  return [
    `【画面内容】${shot.description}`,
    `【运镜】${movementInstruction(shot.movement)}`,
    `【构图】${shot.composition}`,
    `【氛围】${shot.emotion}`,
    `【风格】写实电影感,竖屏短剧,高细节。`,
  ].join('\n');
}

const MEI_AVATAR = 'uploads/projects/1782930008056/characters/Mei/comfyui-44042ad5b86e8f07df689eded48d899dfdc1af2bd19bbb25cac6691f26256828.png';
const SHADOWBLADE_AVATAR = 'uploads/projects/1782930008056/characters/Shadowblade/comfyui-98d9656c50ecd5b5fd1e22165c99ffdbf87cdd0a4fbd51b1269ce5312dd38182.png';

const SHOTS = [
  { id: 'a_baseline_shot9', label: '基线:单角色简单动作,固定机位',
    movement: '固定镜头', composition: '中景构图', emotion: '惊醒，困惑',
    description: '梅猛然从一张干净明亮的科研操作台上惊醒，她身穿白色科研服，周围是闪烁的设备和全息屏幕。',
    refImages: [MEI_AVATAR] },
  { id: 'b_movement_shot1', label: '运镜:平移跟随+变焦,废墟城市俯视',
    movement: '平移跟随，带有轻微的变焦效果', composition: '远景构图，俯视视角', emotion: '宏大，压抑，异变',
    description: '俯视视角，展示了被异变植物和晶体侵蚀的废弃城市，巨大的变异体骨骼矗立在远处，天空阴沉，偶尔有不明飞行物划过。',
    refImages: [MEI_AVATAR] },
  { id: 'c_highrisk_shot55', label: '高风险(rubric判据):跟踪镜头+多人+快剪打斗',
    movement: '跟踪镜头', composition: '全景构图', emotion: '高效，热火朝天',
    description: '梅与巢穴触手怪展开激烈搏斗，快速剪辑展现她闪避、能量刃斩击、臂炮射击的流畅动作。异变影犬影刃配合默契，从侧翼攻击怪物的关节，火花四溅。',
    refImages: [MEI_AVATAR, SHADOWBLADE_AVATAR] },
];

function imageToDataUri(relPath: string): string {
  return `data:image/png;base64,${fs.readFileSync(path.join(ROOT, relPath)).toString('base64')}`;
}

// HNLINK 文档确认的格式(2026-07-06 截图):model + content 数组 + 顶层参数字段
// duration(4-15)/ratio/resolution/watermark/generate_audio 为顶层字段,非文本指令。
// 注意:reference_image 示例为 asset://<approved_asset_id>,上传链路未知,
// 本轮 ref 模式暂不可用(见 POC-REPORT.md),仅保留 data URI 尝试代码待人像库接口确认后启用。
function buildBody(shot: typeof SHOTS[number], mode: 'text' | 'ref', model: string) {
  const content: any[] = [{ type: 'text', text: buildPrompt(shot) }];
  if (mode === 'ref') {
    for (const img of shot.refImages) {
      content.push({ type: 'image_url', image_url: { url: imageToDataUri(img) }, role: 'reference_image' });
    }
  }
  return {
    model,
    content,
    duration: SHOT_DURATION,
    ratio: RATIO,
    resolution: RES,
    watermark: false,
    generate_audio: false,
  };
}

// 网关坑:错误可能包在 HTTP 200 + {code,msg,data} 信封里;成功可能是原生 Ark 响应。两者都处理。
function unwrap(json: any): { businessError: string | null; payload: any } {
  if (json && typeof json.code === 'number' && json.code !== 0 && json.code !== 200) {
    return { businessError: `gateway code ${json.code}: ${json.msg || ''}`, payload: json.data };
  }
  if (json && typeof json.code === 'number') return { businessError: null, payload: json.data ?? json };
  return { businessError: null, payload: json };
}

async function createTask(body: any) {
  const res = await fetch(`${BASE}/api/v3/contents/generations/tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ parseError: true }));
  return { httpStatus: res.status, ...unwrap(json), raw: json };
}

async function pollTask(taskId: string, maxMs = 12 * 60_000) {
  const deadline = Date.now() + maxMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/api/v3/contents/generations/tasks/${taskId}`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    const json = await res.json().catch(() => ({ parseError: true }));
    const { payload } = unwrap(json);
    last = payload ?? json;
    const status = last?.status || 'unknown';
    if (['succeeded', 'failed', 'cancelled', 'expired'].includes(status)) return { status, json: last };
    await new Promise(r => setTimeout(r, 8000));
  }
  return { status: 'poll_timeout', json: last };
}

async function downloadVideo(url: string, destName: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const dest = path.join(VIDEO_DIR, destName);
    fs.writeFileSync(dest, buf);
    return { path: path.relative(ROOT, dest).replace(/\\/g, '/'), bytes: buf.length };
  } catch { return null; }
}

async function main() {
  if (!API_KEY && !DRY) { console.error('HNLINK_API_KEY not set'); process.exit(1); }
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  const modes: Array<'text' | 'ref'> = MODE === 'text' ? ['text'] : MODE === 'ref' ? ['ref'] : ['text', 'ref'];
  const shots = SINGLE ? [SHOTS[0]] : SHOTS;
  const useModes = SINGLE ? (['text'] as const) : modes;
  const runs: any[] = [];
  let workingModel: string | null = null;

  for (const shot of shots) {
    for (const mode of useModes) {
      const tag = `${shot.id}__${mode}__${RES}`;
      if (DRY) {
        const body = buildBody(shot, mode, MODEL_CANDIDATES[0]);
        console.log(`\n===== [DRY] ${tag} =====\n${body.content[0].text}\ncontent items: ${body.content.length}`);
        continue;
      }
      const startedAt = Date.now();
      console.log(`\n===== ${tag} =====`);
      // 模型 ID 发现:未确定前逐个尝试,确定后固定
      let created: any = null; let usedModel = workingModel;
      for (const model of (workingModel ? [workingModel] : MODEL_CANDIDATES)) {
        created = await createTask(buildBody(shot, mode, model));
        console.log(JSON.stringify({ event: 'create_attempt', tag, model, httpStatus: created.httpStatus, businessError: created.businessError, raw: created.businessError ? created.raw : undefined }));
        const modelErr = created.businessError && /model|模型/i.test(created.businessError);
        if (!created.businessError || !modelErr) { usedModel = model; break; }
      }
      const taskId = created?.payload?.id || created?.raw?.id || null;
      if (created.businessError || !taskId) {
        runs.push({ tag, mode, shotId: shot.id, ok: false, stage: 'create', httpStatus: created.httpStatus, error: created.businessError || created.raw, durationMs: Date.now() - startedAt });
        console.log(JSON.stringify({ event: 'create_failed', tag, error: created.businessError, raw: created.raw }));
        continue;
      }
      if (!workingModel && usedModel) { workingModel = usedModel; console.log(JSON.stringify({ event: 'model_locked', model: workingModel })); }
      console.log(JSON.stringify({ event: 'created', tag, taskId, model: usedModel }));
      const polled = await pollTask(taskId);
      const videoUrl = polled.json?.content?.video_url || polled.json?.video_url || polled.json?.data?.video_url || null;
      let saved = null;
      if (videoUrl) saved = await downloadVideo(videoUrl, `${tag}.mp4`);
      const run = {
        tag, mode, shotId: shot.id, model: usedModel, ok: polled.status === 'succeeded',
        taskId, finalStatus: polled.status,
        usage: polled.json?.usage || null,
        videoUrl, savedPath: saved?.path || null, savedBytes: saved?.bytes || null,
        durationMs: Date.now() - startedAt, rawFinal: polled.json,
      };
      console.log(JSON.stringify({ event: 'done', tag, finalStatus: run.finalStatus, usage: run.usage, savedPath: run.savedPath, durationMs: run.durationMs }));
      runs.push(run);
    }
  }
  if (!DRY) {
    const artifact = {
      timestamp: new Date().toISOString(),
      channel: 'HNLINK relay (token.hnlink.net, THIRD-PARTY, http-only) — Ark-shaped requests (Seedance 原厂路径)',
      base: BASE, modelCandidates: MODEL_CANDIDATES, workingModel,
      params: { duration: SHOT_DURATION, resolution: RES, ratio: RATIO },
      runs: runs.map(r => ({ ...r, rawFinal: undefined })),
      rawFinals: Object.fromEntries(runs.filter(r => r.rawFinal).map(r => [r.tag, r.rawFinal])),
    };
    fs.writeFileSync(path.join(OUT_DIR, 'poc-runs.json'), JSON.stringify(artifact, null, 2) + '\n', 'utf8');
    console.log('\nartifact written: docs/seedance-poc/poc-runs.json');
  }
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
