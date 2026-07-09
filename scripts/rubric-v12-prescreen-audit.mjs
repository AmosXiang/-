// rubric v1.2 预筛召回审计(零 API 成本):用库内历史 replicability 报告验证
// prescreen.ts 的候选集能否覆盖历史上被模型多数标记(≥2 轮)的 multi_character_interaction 镜头。
// 设计文档基准(13 份报告前的 12 份):视频1 100% / 视频2 78.6% / 视频3 100%。
// 用法:node scripts/rubric-v12-prescreen-audit.mjs

import Database from 'better-sqlite3';
import { prescreenMultiCharacterShots } from '../server/modules/shot-analysis/prescreen.ts';
import { loadKnowledgeBase } from '../server/modules/shot-analysis/knowledge.ts';

const VIDEO_IDS = ['1782541753229', '1783073819790', '1783192167990'];

// 词表以知识库 replicability-rubric.json 为唯一事实来源。
const kb = loadKnowledgeBase();
const identityDim = kb.replicabilityDimensions.find(d => d.id === 'identityConsistencyPressure');
const { roleFunctionWords: ROLE_FUNCTION_WORDS, pluralInteractionCues: PLURAL_INTERACTION_CUES } = identityDim.prescreen;

const db = new Database('db.sqlite', { readonly: true });
const videos = JSON.parse(db.prepare("SELECT value FROM store WHERE key='videos'").get().value);
const reportRows = db.prepare(
  "SELECT videoId, reportJson, kbVersion, createdAt FROM shot_analysis_reports WHERE analysisType='replicability' AND status='succeeded' ORDER BY createdAt",
).all();

// shotRef 解析:优先 "镜头N";退化为时间戳时按镜头起始时间匹配(历史 12 轮中出现过 1 轮纯时间戳)。
function parseShotIndex(shotRef, shots) {
  const m = String(shotRef).match(/镜头\s*(\d+)/);
  if (m) return Number(m[1]);
  const t = String(shotRef).match(/(\d{1,2}):(\d{2})/);
  if (t) {
    const seconds = Number(t[1]) * 60 + Number(t[2]);
    const idx = shots.findIndex(s => Math.abs(Number(s.timeSeconds) - seconds) <= 1);
    if (idx >= 0) return idx + 1;
  }
  return null;
}

const summary = [];
for (const videoId of VIDEO_IDS) {
  const video = videos.find(v => String(v.id) === videoId);
  const shots = video.analysis.shots;
  const characters = video.analysis.characters || [];

  // 历史多数标记基准:同一镜头被 ≥2 轮报告标记为 multi_character_interaction。
  const markCounts = new Map();
  let rounds = 0;
  for (const row of reportRows.filter(r => r.videoId === videoId)) {
    rounds += 1;
    const report = JSON.parse(row.reportJson);
    const marked = new Set();
    for (const risk of report.shotRisks || []) {
      if (risk.weaknessId !== 'multi_character_interaction') continue;
      const idx = parseShotIndex(risk.shotRef, shots);
      if (idx) marked.add(idx);
    }
    for (const idx of marked) markCounts.set(idx, (markCounts.get(idx) || 0) + 1);
  }
  const majority = [...markCounts.entries()].filter(([, n]) => n >= 2).map(([idx]) => idx).sort((a, b) => a - b);

  const result = prescreenMultiCharacterShots(shots, characters, {
    roleFunctionWords: ROLE_FUNCTION_WORDS,
    pluralInteractionCues: PLURAL_INTERACTION_CUES,
  });
  const candidateSet = new Set(result.candidates.map(c => c.shotIndex));
  const covered = majority.filter(idx => candidateSet.has(idx));
  const missed = majority.filter(idx => !candidateSet.has(idx));

  const row = {
    videoId,
    title: video.title || video.filename,
    rounds,
    totalShots: shots.length,
    candidateCount: result.candidates.length,
    candidateShare: `${(result.candidates.length / shots.length * 100).toFixed(1)}%`,
    majorityMarked: majority.length,
    recall: majority.length ? `${(covered.length / majority.length * 100).toFixed(1)}%` : 'n/a',
    missedShots: missed.map(idx => ({ shotIndex: idx, marks: markCounts.get(idx), description: shots[idx - 1].description })),
  };
  summary.push(row);
  console.log(JSON.stringify(row, null, 2));
}

console.log('---');
console.log(JSON.stringify({
  event: 'audit_summary',
  recalls: Object.fromEntries(summary.map(r => [r.videoId, r.recall])),
  candidateShares: Object.fromEntries(summary.map(r => [r.videoId, r.candidateShare])),
}));
