// thinkingBudget 降本对照实验(实验专用,不改模块任何默认配置,不写 shot_analysis_reports 表)。
// A 组 = 当前默认(不设 thinkingConfig);B 组 = thinkingBudget: 0(关闭思考)。
// 直接复用模块的知识库/prompt/schema 与 server/lib/gemini.ts 客户端,绕过 HTTP。
// 用法: npx tsx scripts/thinking-budget-experiment.ts

import fs from 'node:fs';
import Database from 'better-sqlite3';

import { classifyGeminiError, createGeminiClient, withGeminiTimeout } from '../server/lib/gemini.ts';
import { loadKnowledgeBase } from '../server/modules/shot-analysis/knowledge.ts';
import { buildReplicabilityPrompt, type AnalysisJsonInput } from '../server/modules/shot-analysis/prompt.ts';
import { replicabilityResponseSchema } from '../server/modules/shot-analysis/schema.ts';

const MODEL = 'gemini-2.5-flash';
const VIDEO_IDS = ['1782541753229', '1783073819790', '1783192167990'];
const DIMENSIONS = ['stillFrameGenerability', 'identityConsistencyPressure', 'cameraMotionFeasibility', 'postProductionDependency'];
// pulid_latency 的产出在 v1.1 复验中被证实极不稳定(43→0 / 61→24)且不参与占比评分,
// 因此风险数量对比口径 = 剔除 pulid_latency 后的 shotRisks。
const SCORE_RELEVANT_EXCLUDE = new Set(['pulid_latency']);
const INPUT_PRICE_PER_M = 0.30;
const OUTPUT_PRICE_PER_M = 2.50;
const TIMEOUT_MS = 180_000;

type Arm = { id: 'A_default' | 'B_budget0'; thinkingConfig?: { thinkingBudget: number } };
const ARMS: Arm[] = [
  { id: 'A_default' },
  { id: 'B_budget0', thinkingConfig: { thinkingBudget: 0 } },
];

function loadVideoInput(videoId: string): AnalysisJsonInput {
  const db = new Database('db.sqlite', { readonly: true });
  try {
    const row = db.prepare("SELECT value FROM store WHERE key = 'videos'").get() as { value: string } | undefined;
    const video = (row ? JSON.parse(row.value) : []).find((v: any) => String(v.id) === videoId);
    if (!video?.analysis?.shots?.length) throw new Error(`Video ${videoId} has no analyzed shots`);
    return {
      title: String(video.title || video.filename || videoId),
      genre: video.genre,
      shots: video.analysis.shots,
      characters: video.analysis.characters || [],
      narrative: video.analysis.narrative || {},
    };
  } finally {
    db.close();
  }
}

// 实验内置的合规检查(与 analyzer.validateReplicabilityReport 同规则;该函数未导出,
// 实验按"不改模块代码"约束在此本地重实现,仅用于统计合规率,不做放行/拦截)。
function complianceIssues(report: any, kb: ReturnType<typeof loadKnowledgeBase>): string[] {
  const issues: string[] = [];
  for (const risk of report.shotRisks || []) {
    if (!kb.replicabilityDimensionIds.has(risk.dimensionId)) issues.push(`unknown dimensionId in shotRisks: ${risk.dimensionId}`);
    if (!kb.replicabilityWeaknessIds.has(risk.weaknessId)) issues.push(`unknown weaknessId: ${risk.weaknessId}`);
    if (!Array.isArray(risk.evidence) || !risk.evidence.length) issues.push(`no evidence: ${risk.weaknessId}@${risk.shotRef}`);
  }
  const covered = new Set<string>();
  for (const item of report.scores || []) {
    if (![2, 5, 8, 10].includes(item.score)) issues.push(`score not in {2,5,8,10}: ${item.dimensionId}=${item.score}`);
    if (!Array.isArray(item.evidence) || !item.evidence.length) issues.push(`no score evidence: ${item.dimensionId}`);
    covered.add(item.dimensionId);
  }
  for (const id of kb.replicabilityDimensionIds) if (!covered.has(id)) issues.push(`dimension not scored: ${id}`);
  return issues;
}

const kb = loadKnowledgeBase();
const ai = createGeminiClient();
const runs: any[] = [];

for (const arm of ARMS) {
  for (const videoId of VIDEO_IDS) {
    const input = loadVideoInput(videoId);
    const startedAt = Date.now();
    console.log(JSON.stringify({ event: 'run_start', arm: arm.id, videoId, shots: input.shots.length, timestamp: new Date().toISOString() }));
    try {
      const response = await withGeminiTimeout(ai.models.generateContent({
        model: MODEL,
        contents: [{ text: buildReplicabilityPrompt(kb, input) }],
        config: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema: replicabilityResponseSchema,
          ...(arm.thinkingConfig ? { thinkingConfig: arm.thinkingConfig } : {}),
        },
      }), TIMEOUT_MS);
      const report = JSON.parse(String(response.text || ''));
      const issues = complianceIssues(report, kb);
      const usage = response.usageMetadata || {};
      const promptTokens = usage.promptTokenCount || 0;
      const totalTokens = usage.totalTokenCount || 0;
      const candidateTokens = usage.candidatesTokenCount || 0;
      const billedOutput = Math.max(0, totalTokens - promptTokens);
      const thinkingTokens = Math.max(0, billedOutput - candidateTokens);
      const cost = promptTokens / 1e6 * INPUT_PRICE_PER_M + billedOutput / 1e6 * OUTPUT_PRICE_PER_M;
      const breakdown = (report.shotRisks || []).reduce((acc: Record<string, number>, r: any) => {
        acc[r.weaknessId] = (acc[r.weaknessId] || 0) + 1; return acc;
      }, {});
      const scoreRelevantRiskCount = (report.shotRisks || []).filter((r: any) => !SCORE_RELEVANT_EXCLUDE.has(r.weaknessId)).length;
      const run = {
        event: 'run_summary',
        arm: arm.id,
        videoId,
        scores: Object.fromEntries(DIMENSIONS.map(id => [id, (report.scores || []).find((s: any) => s.dimensionId === id)?.score ?? null])),
        identityEvidence: (report.scores || []).find((s: any) => s.dimensionId === 'identityConsistencyPressure')?.evidence || [],
        shotRiskCountTotal: (report.shotRisks || []).length,
        scoreRelevantRiskCount,
        riskBreakdown: breakdown,
        weaknessTypesFound: Object.keys(breakdown).sort(),
        complianceIssues: issues,
        usage: { promptTokens, candidateTokens, totalTokens, thinkingTokens, billedOutput },
        costUSD: Math.round(cost * 1e6) / 1e6,
        durationMs: Date.now() - startedAt,
      };
      runs.push(run);
      console.log(JSON.stringify(run));
    } catch (error: any) {
      const classified = classifyGeminiError(error);
      const failure = { event: 'run_failed', arm: arm.id, videoId, code: classified.code, detail: String(error?.message || error), durationMs: Date.now() - startedAt };
      runs.push(failure);
      console.error(JSON.stringify(failure));
    }
  }
}

// 逐视频对比 + 预注册判定线
const comparisons = VIDEO_IDS.map(videoId => {
  const a = runs.find(r => r.arm === 'A_default' && r.videoId === videoId && r.event === 'run_summary');
  const b = runs.find(r => r.arm === 'B_budget0' && r.videoId === videoId && r.event === 'run_summary');
  if (!a || !b) return { videoId, incomparable: true };
  const typesMissedByB = a.weaknessTypesFound.filter((t: string) => (a.riskBreakdown[t] || 0) >= 2 && !(t in b.riskBreakdown));
  const countDeltaPct = a.scoreRelevantRiskCount ? Math.round(Math.abs(b.scoreRelevantRiskCount - a.scoreRelevantRiskCount) / a.scoreRelevantRiskCount * 1000) / 10 : null;
  const bandShifts = DIMENSIONS.filter(id => a.scores[id] !== b.scores[id]).map(id => `${id}:${a.scores[id]}→${b.scores[id]}`);
  return { videoId, typesMissedByB, countDeltaPct, bandShifts, costA: a.costUSD, costB: b.costUSD, complianceIssuesB: b.complianceIssues };
});

const materialityCriteria = {
  c1_typeMissing: comparisons.some((c: any) => c.typesMissedByB?.length),
  c2_countDeltaOver25pct: comparisons.some((c: any) => c.countDeltaPct !== null && c.countDeltaPct > 25),
  c3_bandShiftsAtLeast2of12: comparisons.reduce((n: number, c: any) => n + (c.bandShifts?.length || 0), 0) >= 2,
  c4_complianceFailureInB: runs.some(r => r.arm === 'B_budget0' && (r.event === 'run_failed' || (r.complianceIssues || []).length > 0)),
};
const verdict = {
  event: 'verdict',
  materialityCriteria,
  materialDifference: Object.values(materialityCriteria).some(Boolean),
  totalCostA: Math.round(runs.filter(r => r.arm === 'A_default' && r.costUSD).reduce((s, r) => s + r.costUSD, 0) * 1e6) / 1e6,
  totalCostB: Math.round(runs.filter(r => r.arm === 'B_budget0' && r.costUSD).reduce((s, r) => s + r.costUSD, 0) * 1e6) / 1e6,
};
console.log(JSON.stringify({ event: 'comparison', comparisons }));
console.log(JSON.stringify(verdict));

fs.writeFileSync('thinking-budget-experiment.json', `${JSON.stringify({ timestamp: new Date().toISOString(), model: MODEL, arms: ARMS, kbVersion: kb.replicabilityVersion, pricingUSDPerMillionTokens: { input: INPUT_PRICE_PER_M, output: OUTPUT_PRICE_PER_M }, runs, comparisons, verdict }, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ event: 'artifact_written', artifact: 'thinking-budget-experiment.json' }));
