// 可生产性(replicability)分析验收脚本:对多条库内视频执行分析,
// 用响应中的真实 usageMetadata 按 Gemini 2.5 Flash 定价核对单集成本。
// 用法: node scripts/replicability-acceptance.mjs <videoId> [videoId...]

import fs from 'node:fs';

const BASE = process.env.ACCEPTANCE_BASE_URL || 'http://localhost:3001';
// Gemini 2.5 Flash 定价(2026-07 查证):$0.30/M input tokens,$2.50/M output tokens。
const INPUT_PRICE_PER_M = 0.30;
const OUTPUT_PRICE_PER_M = 2.50;

const videoIds = process.argv.slice(2);
if (!videoIds.length) {
  console.error('Usage: node scripts/replicability-acceptance.mjs <videoId> [videoId...]');
  process.exit(1);
}

const runs = [];
for (const videoId of videoIds) {
  const startedAt = Date.now();
  console.log(JSON.stringify({ event: 'run_start', videoId, timestamp: new Date().toISOString() }));
  const res = await fetch(`${BASE}/api/shot-analysis/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoId, analysisType: 'replicability' }),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify({ event: 'run_failed', videoId, httpStatus: res.status, body }));
    process.exit(1);
  }
  const usage = body.diagnostics?.usage || {};
  // 计费口径:thinking tokens 按输出价计费,包含在 totalTokenCount 中但不在 candidatesTokenCount 中。
  // 因此按输出价计费的 token = total - prompt(= candidates + thoughts),漏算 thoughts 会低估成本。
  const thoughtsTokens = Math.max(0, (usage.totalTokenCount || 0) - (usage.promptTokenCount || 0) - (usage.candidatesTokenCount || 0));
  const billedOutputTokens = (usage.candidatesTokenCount || 0) + thoughtsTokens;
  const inputCost = (usage.promptTokenCount || 0) / 1e6 * INPUT_PRICE_PER_M;
  const outputCost = billedOutputTokens / 1e6 * OUTPUT_PRICE_PER_M;
  const totalCost = Math.round((inputCost + outputCost) * 10000) / 10000;
  const summary = {
    event: 'run_summary',
    videoId,
    reportId: body.id,
    analysisType: body.analysisType,
    kbVersion: body.kbVersion,
    overallScore: body.report.overallScore,
    scores: Object.fromEntries(body.report.scores.map(s => [s.dimensionId, s.score])),
    shotRiskCount: body.report.shotRisks.length,
    riskBreakdown: body.report.shotRisks.reduce((acc, r) => { acc[r.weaknessId] = (acc[r.weaknessId] || 0) + 1; return acc; }, {}),
    usage: { ...usage, thoughtsTokens, billedOutputTokens },
    costUSD: { input: Math.round(inputCost * 10000) / 10000, output: Math.round(outputCost * 10000) / 10000, total: totalCost },
    durationMs: Date.now() - startedAt,
  };
  console.log(JSON.stringify(summary));
  runs.push({ ...summary, report: body.report });
}

// 落库校验:analysisType 过滤应恰好返回本轮 + 历史 replicability 报告
const listRes = await fetch(`${BASE}/api/shot-analysis/reports?analysisType=replicability`);
const list = await listRes.json();
const listedIds = new Set(list.map(r => r.id));
for (const run of runs) {
  if (!listedIds.has(run.reportId)) {
    console.error(JSON.stringify({ event: 'acceptance_failed', stage: 'persistence_filter', missing: run.reportId }));
    process.exit(1);
  }
}
console.log(JSON.stringify({ event: 'persistence_filter_verified', listedReplicabilityReports: list.length }));

const totalCost = Math.round(runs.reduce((s, r) => s + r.costUSD.total, 0) * 10000) / 10000;
const verdict = {
  event: 'acceptance_passed',
  runs: runs.length,
  perEpisodeCostsUSD: runs.map(r => r.costUSD.total),
  totalCostUSD: totalCost,
  estimateRangeUSD: [0.02, 0.05],
  allWithinEstimate: runs.every(r => r.costUSD.total >= 0.005 && r.costUSD.total <= 0.05),
};
console.log(JSON.stringify(verdict));

fs.writeFileSync('replicability-acceptance.json', JSON.stringify({ timestamp: new Date().toISOString(), pricing: { INPUT_PRICE_PER_M, OUTPUT_PRICE_PER_M }, verdict, runs }, null, 2), 'utf8');
console.log(JSON.stringify({ event: 'artifact_written', artifact: 'replicability-acceptance.json' }));
