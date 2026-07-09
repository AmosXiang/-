// rubric v1.2 验证协议(设计文档第 3 节):3 条库内视频 × 3 轮独立运行。
// 通过线:每视频 3 轮 identity 分数零变化。
// 同时完整披露:逐候选裁决翻转率、各视频占比到区间边界的距离、真实 token 成本。
// 用法:先启动服务端,然后 ACCEPTANCE_BASE_URL=http://localhost:3299 node scripts/rubric-v12-verification.mjs

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
  const candidatesTokenCount = usage.candidatesTokenCount || 0;
  const totalTokenCount = usage.totalTokenCount || 0;
  const billedOutputTokens = Math.max(0, totalTokenCount - promptTokenCount);
  const scoreRows = Object.fromEntries(body.report.scores.map(item => [item.dimensionId, item]));
  const sc = body.report.serverComputed?.identityConsistencyPressure;
  return {
    event: 'run_summary',
    round: roundNumber,
    videoId,
    reportId: body.id,
    kbVersion: body.kbVersion,
    overallScore: body.report.overallScore,
    scores: Object.fromEntries(DIMENSIONS.map(id => [id, scoreRows[id]?.score])),
    identityEvidence: scoreRows.identityConsistencyPressure?.evidence || [],
    serverComputed: sc ? {
      candidateCount: sc.candidateCount,
      hitCount: sc.hitCount,
      ratio: sc.ratio,
      hitShotIndexes: sc.hitShotIndexes,
      hitsToNextBand: sc.hitsToNextBand,
      verdicts: sc.verdicts,
    } : null,
    aggregateAdvisories: (body.report.aggregateAdvisories || []).map(a => ({ weaknessId: a.weaknessId, ratio: a.ratio })),
    shotRiskCount: body.report.shotRisks.length,
    adjudication: body.diagnostics?.adjudication || null,
    usageBreakdown: body.diagnostics?.usageBreakdown || null,
    usage: { promptTokenCount, candidatesTokenCount, totalTokenCount, billedOutputTokens },
    costUSD: {
      input: round6(promptTokenCount / 1e6 * INPUT_PRICE_PER_M),
      output: round6(billedOutputTokens / 1e6 * OUTPUT_PRICE_PER_M),
      total: round6(promptTokenCount / 1e6 * INPUT_PRICE_PER_M + billedOutputTokens / 1e6 * OUTPUT_PRICE_PER_M),
    },
    durationMs,
  };
}

const runs = [];
for (let roundNumber = 1; roundNumber <= ROUNDS; roundNumber += 1) {
  for (const videoId of VIDEO_IDS) {
    const startedAt = Date.now();
    console.log(JSON.stringify({ event: 'run_start', round: roundNumber, videoId, timestamp: new Date().toISOString() }));
    const response = await fetch(`${BASE}/api/shot-analysis/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, analysisType: 'replicability' }),
    });
    const body = await response.json();
    if (!response.ok) {
      console.error(JSON.stringify({ event: 'run_failed', round: roundNumber, videoId, httpStatus: response.status, body }));
      process.exit(1);
    }
    const run = summarize(roundNumber, videoId, body, Date.now() - startedAt);
    runs.push(run);
    console.log(JSON.stringify({ ...run, verdicts: undefined, identityEvidence: undefined }));
  }
}

// 逐视频稳定性 + 逐候选翻转率
const perVideo = VIDEO_IDS.map(videoId => {
  const vRuns = [1, 2, 3].map(r => runs.find(run => run.videoId === videoId && run.round === r));
  const identityScores = vRuns.map(r => r.scores.identityConsistencyPressure);
  const hitCounts = vRuns.map(r => r.serverComputed?.hitCount ?? null);
  const candidateCounts = vRuns.map(r => r.serverComputed?.candidateCount ?? null);

  // 逐候选翻转:同一 shotIndex 在 3 轮中的裁决是否一致
  const verdictByShot = new Map();
  for (const r of vRuns) {
    for (const v of r.serverComputed?.verdicts || []) {
      if (!verdictByShot.has(v.shotIndex)) verdictByShot.set(v.shotIndex, []);
      verdictByShot.get(v.shotIndex).push(v.verdict);
    }
  }
  const flipped = [...verdictByShot.entries()].filter(([, vs]) => new Set(vs).size > 1);
  return {
    videoId,
    identityScores: identityScores.join('→'),
    identityStable: new Set(identityScores).size === 1,
    overallScores: vRuns.map(r => r.overallScore).join('→'),
    candidateCounts: candidateCounts.join('→'),
    candidateCountStable: new Set(candidateCounts).size === 1,
    hitCounts: hitCounts.join('→'),
    hitsToNextBand: vRuns.map(r => r.serverComputed?.hitsToNextBand).join('→'),
    candidateTotal: verdictByShot.size,
    flippedCandidates: flipped.map(([shotIndex, vs]) => ({ shotIndex, verdicts: vs })),
    flipRate: verdictByShot.size ? `${(flipped.length / verdictByShot.size * 100).toFixed(1)}%` : 'n/a',
  };
});
console.log(JSON.stringify({ event: 'per_video', perVideo }, null, 2));

const checks = {
  identityScoreZeroVarianceEveryVideo: perVideo.every(v => v.identityStable),
  candidateSetDeterministic: perVideo.every(v => v.candidateCountStable),
  allKbVersionsV120: runs.every(run => run.kbVersion === 'replicability@1.2.0'),
  allRuns: runs.length === VIDEO_IDS.length * ROUNDS,
};
const totals = {
  promptTokens: runs.reduce((s, r) => s + r.usage.promptTokenCount, 0),
  billedOutputTokens: runs.reduce((s, r) => s + r.usage.billedOutputTokens, 0),
  costUSD: round6(runs.reduce((s, r) => s + r.costUSD.total, 0)),
};
const artifact = {
  timestamp: new Date().toISOString(),
  protocol: '3 videos x 3 rounds, pass line: identity score zero variance per video (RUBRIC-V1.2-DESIGN.md §3)',
  pricingUSDPerMillionTokens: { input: INPUT_PRICE_PER_M, output: OUTPUT_PRICE_PER_M },
  videoIds: VIDEO_IDS,
  runs,
  perVideo,
  checks,
  totals,
};
fs.writeFileSync('rubric-v12-verification.json', `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ event: 'validation', checks, totals }));
console.log(JSON.stringify({ event: 'artifact_written', artifact: 'rubric-v12-verification.json' }));
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
