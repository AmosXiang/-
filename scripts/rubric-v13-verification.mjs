// rubric v1.3 验证协议(RUBRIC-V1.3-DESIGN.md 第 3 节):3 条库内视频 × 3 轮独立运行。
// 通过线:每视频四个维度分数全部零变化(overallScore 随之零变化)。
// 同时完整披露:逐 (镜头, 弱项) 对裁决翻转率、各维度 hitsToNextBand、真实 token 成本。
// 用法:先启动服务端,然后 ACCEPTANCE_BASE_URL=http://localhost:3299 node scripts/rubric-v13-verification.mjs

import fs from 'node:fs';

const BASE = process.env.ACCEPTANCE_BASE_URL || 'http://localhost:3001';
const VIDEO_IDS = ['1782541753229', '1783073819790', '1783192167990'];
const ROUNDS = 3;
const DIMENSIONS = ['stillFrameGenerability', 'identityConsistencyPressure', 'cameraMotionFeasibility', 'postProductionDependency'];
const INPUT_PRICE_PER_M = 0.30;
const OUTPUT_PRICE_PER_M = 2.50;

const round6 = v => Math.round(v * 1e6) / 1e6;

function summarize(roundNumber, videoId, body, durationMs) {
  const usage = body.diagnostics?.usage || {};
  const promptTokenCount = usage.promptTokenCount || 0;
  const totalTokenCount = usage.totalTokenCount || 0;
  const billedOutputTokens = Math.max(0, totalTokenCount - promptTokenCount);
  const scoreRows = Object.fromEntries(body.report.scores.map(item => [item.dimensionId, item]));
  const sc = body.report.serverComputed || {};
  return {
    event: 'run_summary',
    round: roundNumber,
    videoId,
    reportId: body.id,
    kbVersion: body.kbVersion,
    overallScore: body.report.overallScore,
    scores: Object.fromEntries(DIMENSIONS.map(id => [id, scoreRows[id]?.score])),
    serverComputed: Object.fromEntries(DIMENSIONS.map(id => [id, sc[id] ? {
      candidateCount: sc[id].candidateCount,
      hitCount: sc[id].hitCount,
      ratio: sc[id].ratio,
      hitShotIndexes: sc[id].hitShotIndexes,
      hitsToNextBand: sc[id].hitsToNextBand,
      verdicts: sc[id].verdicts,
    } : null])),
    aggregateAdvisories: (body.report.aggregateAdvisories || []).map(a => ({ weaknessId: a.weaknessId, ratio: a.ratio })),
    shotRiskCount: body.report.shotRisks.length,
    improvementCount: body.report.improvements.length,
    adjudication: body.diagnostics?.adjudication || null,
    usageBreakdown: body.diagnostics?.usageBreakdown || null,
    usage: { promptTokenCount, totalTokenCount, billedOutputTokens },
    costUSD: {
      input: round6(promptTokenCount / 1e6 * INPUT_PRICE_PER_M),
      output: round6(billedOutputTokens / 1e6 * OUTPUT_PRICE_PER_M),
      total: round6(promptTokenCount / 1e6 * INPUT_PRICE_PER_M + billedOutputTokens / 1e6 * OUTPUT_PRICE_PER_M),
    },
    durationMs,
  };
}

// 运行级重试:仅针对上游标记 retryable 的瞬时故障(503 容量高峰/429 限流),退避 90s,最多 5 次。
// 非 retryable 错误(如 GEMINI_INVALID_RESPONSE)立即失败——那是要暴露的问题,不是要扛过去的。
async function runOnce(roundNumber, videoId) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const startedAt = Date.now();
    console.log(JSON.stringify({ event: 'run_start', round: roundNumber, videoId, attempt, timestamp: new Date().toISOString() }));
    const response = await fetch(`${BASE}/api/shot-analysis/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, analysisType: 'replicability' }),
    });
    const body = await response.json();
    if (response.ok) return summarize(roundNumber, videoId, body, Date.now() - startedAt);
    console.error(JSON.stringify({ event: 'run_failed', round: roundNumber, videoId, attempt, httpStatus: response.status, body }));
    if (!body?.error?.retryable || attempt === 5) process.exit(1);
    await new Promise(resolve => setTimeout(resolve, 90_000));
  }
}

const runs = [];
for (let roundNumber = 1; roundNumber <= ROUNDS; roundNumber += 1) {
  for (const videoId of VIDEO_IDS) {
    const run = await runOnce(roundNumber, videoId);
    runs.push(run);
    console.log(JSON.stringify({ ...run, serverComputed: undefined }));
  }
}

// 逐视频 × 逐维度稳定性 + 逐 (镜头, 弱项) 对翻转率
const perVideo = VIDEO_IDS.map(videoId => {
  const vRuns = [1, 2, 3].map(r => runs.find(run => run.videoId === videoId && run.round === r));
  const dims = DIMENSIONS.map(dimId => {
    const scores = vRuns.map(r => r.scores[dimId]);
    const hitCounts = vRuns.map(r => r.serverComputed[dimId]?.hitCount ?? null);
    const candidateCounts = vRuns.map(r => r.serverComputed[dimId]?.candidateCount ?? null);
    const verdictByPair = new Map();
    for (const r of vRuns) {
      for (const v of r.serverComputed[dimId]?.verdicts || []) {
        const key = `${v.shotIndex}:${v.weaknessId || ''}`;
        if (!verdictByPair.has(key)) verdictByPair.set(key, []);
        verdictByPair.get(key).push(v.verdict);
      }
    }
    const flipped = [...verdictByPair.entries()].filter(([, vs]) => new Set(vs).size > 1);
    return {
      dimensionId: dimId,
      scores: scores.join('→'),
      stable: new Set(scores).size === 1,
      candidateCounts: candidateCounts.join('→'),
      candidateCountStable: new Set(candidateCounts).size === 1,
      hitCounts: hitCounts.join('→'),
      hitsToNextBand: vRuns.map(r => r.serverComputed[dimId]?.hitsToNextBand).join('→'),
      pairTotal: verdictByPair.size,
      flippedPairs: flipped.map(([key, vs]) => ({ pair: key, verdicts: vs })),
      flipRate: verdictByPair.size ? `${(flipped.length / verdictByPair.size * 100).toFixed(1)}%` : 'n/a',
    };
  });
  return {
    videoId,
    overallScores: vRuns.map(r => r.overallScore).join('→'),
    overallStable: new Set(vRuns.map(r => r.overallScore)).size === 1,
    dims,
  };
});
console.log(JSON.stringify({ event: 'per_video', perVideo }, null, 2));

const checks = {
  allDimensionScoresZeroVariance: perVideo.every(v => v.dims.every(d => d.stable)),
  overallScoreZeroVarianceEveryVideo: perVideo.every(v => v.overallStable),
  candidateSetsDeterministic: perVideo.every(v => v.dims.every(d => d.candidateCountStable)),
  allKbVersionsV131: runs.every(run => run.kbVersion === 'replicability@1.3.1'),
  allRuns: runs.length === VIDEO_IDS.length * ROUNDS,
};
const totals = {
  promptTokens: runs.reduce((s, r) => s + r.usage.promptTokenCount, 0),
  billedOutputTokens: runs.reduce((s, r) => s + r.usage.billedOutputTokens, 0),
  costUSD: round6(runs.reduce((s, r) => s + r.costUSD.total, 0)),
};
const artifact = {
  timestamp: new Date().toISOString(),
  protocol: '3 videos x 3 rounds, pass line: all four dimension scores zero variance per video (RUBRIC-V1.3-DESIGN.md §3)',
  pricingUSDPerMillionTokens: { input: INPUT_PRICE_PER_M, output: OUTPUT_PRICE_PER_M },
  videoIds: VIDEO_IDS,
  runs,
  perVideo,
  checks,
  totals,
};
fs.writeFileSync('rubric-v13-verification.json', `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ event: 'validation', checks, totals }));
console.log(JSON.stringify({ event: 'artifact_written', artifact: 'rubric-v13-verification.json' }));
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
