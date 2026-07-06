// 拉片模块验收脚本:对库内真实视频执行分析,校验落库,产出验收工件。
// 用法: node scripts/shot-analysis-acceptance.mjs <videoId>
// 前置: 本地服务已在 3001 端口运行,GEMINI_API_KEY 已配置。

import fs from 'node:fs';

const BASE = process.env.ACCEPTANCE_BASE_URL || 'http://localhost:3001';
const videoId = process.argv[2];
if (!videoId) {
  console.error('Usage: node scripts/shot-analysis-acceptance.mjs <videoId>');
  process.exit(1);
}

const startedAt = Date.now();
console.log(JSON.stringify({ event: 'acceptance_start', videoId, base: BASE, timestamp: new Date().toISOString() }));

const analyzeRes = await fetch(`${BASE}/api/shot-analysis/analyze`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ videoId }),
});
const analyzeBody = await analyzeRes.json();
console.log(JSON.stringify({ event: 'analyze_response', httpStatus: analyzeRes.status, durationMs: Date.now() - startedAt }));

if (!analyzeRes.ok) {
  console.error(JSON.stringify({ event: 'acceptance_failed', stage: 'analyze', body: analyzeBody }));
  process.exit(1);
}

const { id, report, diagnostics, kbVersion } = analyzeBody;
console.log(JSON.stringify({
  event: 'report_summary',
  reportId: id,
  kbVersion,
  overallScore: report.overallScore,
  hookPatterns: report.hookAnalysis.detectedPatterns.map(p => `${p.patternId}:${p.strength}`),
  reversalCount: report.structureAnalysis.reversals.length,
  scores: Object.fromEntries(report.scores.map(s => [s.dimensionId, s.score])),
  improvementCount: report.improvements.length,
  diagnostics,
}));

// 校验落库
const persistedRes = await fetch(`${BASE}/api/shot-analysis/reports/${id}`);
const persisted = await persistedRes.json();
if (!persistedRes.ok || persisted.status !== 'succeeded' || !persisted.report) {
  console.error(JSON.stringify({ event: 'acceptance_failed', stage: 'persistence', httpStatus: persistedRes.status, body: persisted }));
  process.exit(1);
}
console.log(JSON.stringify({ event: 'persistence_verified', reportId: id, status: persisted.status, kbVersion: persisted.kbVersion, requestId: persisted.requestId }));

const artifact = {
  timestamp: new Date().toISOString(),
  videoId,
  reportId: id,
  kbVersion,
  diagnostics,
  report,
  persistedRow: { id: persisted.id, status: persisted.status, kbVersion: persisted.kbVersion, model: persisted.model, requestId: persisted.requestId, durationMs: persisted.durationMs, createdAt: persisted.createdAt },
};
fs.writeFileSync('shot-analysis-acceptance.json', JSON.stringify(artifact, null, 2), 'utf8');
console.log(JSON.stringify({ event: 'acceptance_passed', artifact: 'shot-analysis-acceptance.json', totalDurationMs: Date.now() - startedAt }));
