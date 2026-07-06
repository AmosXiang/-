// Rubric v1.1 稳定性复验:固定 3 个视频各运行两轮,保留逐维度证据与真实 token 成本。

import fs from 'node:fs';

const BASE = process.env.ACCEPTANCE_BASE_URL || 'http://localhost:3001';
const VIDEO_IDS = ['1782541753229', '1783073819790', '1783192167990'];
const DIMENSIONS = [
  'stillFrameGenerability',
  'identityConsistencyPressure',
  'cameraMotionFeasibility',
  'postProductionDependency',
];
const ALLOWED_SCORES = new Set([2, 5, 8, 10]);
const INPUT_PRICE_PER_M = 0.30;
const OUTPUT_PRICE_PER_M = 2.50;

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function summarize(roundNumber, videoId, body, durationMs) {
  const usage = body.diagnostics?.usage || {};
  const promptTokenCount = usage.promptTokenCount || 0;
  const candidatesTokenCount = usage.candidatesTokenCount || 0;
  const totalTokenCount = usage.totalTokenCount || 0;
  const billedOutputTokens = Math.max(0, totalTokenCount - promptTokenCount);
  const thinkingTokens = Math.max(0, billedOutputTokens - candidatesTokenCount);
  const inputCost = promptTokenCount / 1e6 * INPUT_PRICE_PER_M;
  const outputCost = billedOutputTokens / 1e6 * OUTPUT_PRICE_PER_M;
  const scoreRows = Object.fromEntries(body.report.scores.map(item => [item.dimensionId, {
    score: item.score,
    evidence: item.evidence,
  }]));
  return {
    event: 'run_summary',
    round: roundNumber,
    videoId,
    reportId: body.id,
    analysisType: body.analysisType,
    kbVersion: body.kbVersion,
    overallScore: body.report.overallScore,
    scores: Object.fromEntries(DIMENSIONS.map(id => [id, scoreRows[id]?.score])),
    evidence: Object.fromEntries(DIMENSIONS.map(id => [id, scoreRows[id]?.evidence || []])),
    shotRiskCount: body.report.shotRisks.length,
    riskBreakdown: body.report.shotRisks.reduce((acc, risk) => {
      acc[risk.weaknessId] = (acc[risk.weaknessId] || 0) + 1;
      return acc;
    }, {}),
    usage: { promptTokenCount, candidatesTokenCount, totalTokenCount, thinkingTokens, billedOutputTokens },
    costUSD: { input: round(inputCost), output: round(outputCost), total: round(inputCost + outputCost) },
    durationMs,
  };
}

const runs = [];
for (let roundNumber = 1; roundNumber <= 2; roundNumber += 1) {
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
    console.log(JSON.stringify(run));
  }
}

const comparisons = VIDEO_IDS.map(videoId => {
  const first = runs.find(run => run.videoId === videoId && run.round === 1);
  const second = runs.find(run => run.videoId === videoId && run.round === 2);
  return {
    videoId,
    scores: Object.fromEntries(DIMENSIONS.map(id => [id, `${first.scores[id]}→${second.scores[id]}`])),
    identityStable: first.scores.identityConsistencyPressure === second.scores.identityConsistencyPressure,
  };
});
console.log(JSON.stringify({ event: 'comparison', comparisons }));

const checks = {
  identityStableForEveryVideo: comparisons.every(item => item.identityStable),
  all24ScoresAllowed: runs.length === 6 && runs.every(run => DIMENSIONS.every(id => ALLOWED_SCORES.has(run.scores[id]))),
  everyDimensionHasRatioEvidence: runs.every(run => DIMENSIONS.every(id =>
    run.evidence[id].some(text => /\d+\s*个?镜头中\s*(?:有\s*)?\d+|\d+\s*[/／]\s*\d+/.test(text) && /占比\s*\d+(?:\.\d+)?\s*[%％]/.test(text)))),
  allKbVersionsV110: runs.every(run => run.kbVersion === 'replicability@1.1.1'),
};
const totals = {
  promptTokens: runs.reduce((sum, run) => sum + run.usage.promptTokenCount, 0),
  billedOutputTokens: runs.reduce((sum, run) => sum + run.usage.billedOutputTokens, 0),
  costUSD: round(runs.reduce((sum, run) => sum + run.costUSD.total, 0)),
};
const artifact = {
  timestamp: new Date().toISOString(),
  pricingUSDPerMillionTokens: { input: INPUT_PRICE_PER_M, output: OUTPUT_PRICE_PER_M },
  videoIds: VIDEO_IDS,
  dimensions: DIMENSIONS,
  runs,
  comparisons,
  checks,
  totals,
};
fs.writeFileSync('replicability-stability.json', `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ event: 'validation', checks, totals }));
console.log(JSON.stringify({ event: 'artifact_written', artifact: 'replicability-stability.json' }));
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
