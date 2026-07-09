// 拉片分析核心。复用 server/lib/gemini.ts 中提取自 server.ts 的既有封装:
// 每次调用构造客户端、withGeminiTimeout、classifyGeminiError、maxAttempts=2 + 500*attempt 退避、
// 视频走 Files API 上传-轮询-清理。失败语义:类型化错误直接抛出,任何路径不产出编造的报告。
// v1.2(replicability):identityConsistencyPressure 改为服务端确定性预筛 + 模型逐候选裁决,
// 计数/占比/锚点映射/算分全部服务端;pulid_latency 改为服务端聚合 advisory。
// 设计与验证协议见 docs/shot-analysis/RUBRIC-V1.2-DESIGN.md。

import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  classifyGeminiError,
  createGeminiClient,
  deleteGeminiFile,
  uploadFileToGemini,
  videoMimeType,
  withGeminiTimeout,
} from '../../lib/gemini.ts';
import { loadKnowledgeBase, type KnowledgeBase, type ReplicabilityDimension } from './knowledge.ts';
import { buildAnalysisJsonPrompt, buildReplicabilityPrompt, buildVideoPrompt, type AnalysisJsonInput } from './prompt.ts';
import { adjudicationResponseSchema, buildAdjudicationPrompt, validateVerdicts, type AdjudicationVerdict } from './adjudicator.ts';
import {
  countIdentityLockedShots,
  hitsToNextBand,
  prescreenMultiCharacterShots,
  ratioToAnchorScore,
  type PrescreenResult,
} from './prescreen.ts';
import { replicabilityResponseSchema, shotAnalysisResponseSchema, type DimensionScore, type ReplicabilityReport, type ShotAnalysisReport } from './schema.ts';

export const SHOT_ANALYSIS_MODEL = 'gemini-2.5-flash';
export const ANALYSIS_TYPES = ['narrative', 'replicability'] as const;
export type AnalysisType = (typeof ANALYSIS_TYPES)[number];
const MAX_ATTEMPTS = 2;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

export type ShotAnalysisInput =
  | { sourceType: 'analysis_json'; videoId: string; input: AnalysisJsonInput }
  | { sourceType: 'video'; filename: string; fullFilePath: string };

export type GeminiUsage = {
  promptTokenCount: number | null;
  candidatesTokenCount: number | null;
  totalTokenCount: number | null;
};

export type ShotAnalysisSuccess = {
  report: ShotAnalysisReport | ReplicabilityReport;
  analysisType: AnalysisType;
  kbVersion: string;
  model: string;
  requestId: string;
  attempts: number;
  durationMs: number;
  usage: GeminiUsage;
  // v1.2:replicability 为两次调用(裁决 + 主报告),usage 为合计;分项在此披露。
  usageBreakdown?: { main: GeminiUsage; adjudication: GeminiUsage | null };
  adjudication?: { candidateCount: number; hitCount: number; attempts: number };
};

function invalidResponse(detail: string): Error {
  return Object.assign(new Error(detail), { code: 'GEMINI_INVALID_RESPONSE' });
}

function sumUsage(a: GeminiUsage, b: GeminiUsage | null): GeminiUsage {
  if (!b) return a;
  const add = (x: number | null, y: number | null) => (x === null && y === null ? null : (x || 0) + (y || 0));
  return {
    promptTokenCount: add(a.promptTokenCount, b.promptTokenCount),
    candidatesTokenCount: add(a.candidatesTokenCount, b.candidatesTokenCount),
    totalTokenCount: add(a.totalTokenCount, b.totalTokenCount),
  };
}

// 服务端校验:封闭 id 域 + 必需字段。不合法直接判 GEMINI_INVALID_RESPONSE,不静默丢弃。
function validateReport(raw: any, kb: KnowledgeBase): ShotAnalysisReport {
  if (!raw || typeof raw !== 'object') throw invalidResponse('Report is not an object');
  for (const match of raw.hookAnalysis?.detectedPatterns || []) {
    if (!kb.hookPatternIds.has(match.patternId)) throw invalidResponse(`Unknown hook patternId: ${match.patternId}`);
    if (!['strong', 'medium', 'weak'].includes(match.strength)) throw invalidResponse(`Invalid hook strength: ${match.strength}`);
    if (!Array.isArray(match.evidence) || !match.evidence.length) throw invalidResponse(`Hook pattern ${match.patternId} has no evidence`);
  }
  const structurePatterns = raw.structureAnalysis?.detectedPatterns || [];
  for (const match of structurePatterns) {
    if (!kb.dramaPatternIds.has(match.patternId)) throw invalidResponse(`Unknown drama patternId: ${match.patternId}`);
    if (!Array.isArray(match.evidence)) throw invalidResponse(`Drama pattern ${match.patternId} evidence must be an array`);
  }
  const coveredDramaIds = new Set(structurePatterns.map((m: any) => m.patternId));
  for (const id of kb.dramaPatternIds) {
    if (!coveredDramaIds.has(id)) throw invalidResponse(`Drama pattern not covered in report: ${id}`);
  }
  const scores: DimensionScore[] = raw.scores || [];
  const coveredDims = new Set<string>();
  for (const item of scores) {
    if (!kb.dimensionIds.has(item.dimensionId)) throw invalidResponse(`Unknown dimensionId: ${item.dimensionId}`);
    if (typeof item.score !== 'number' || item.score < 0 || item.score > 10) throw invalidResponse(`Score out of range for ${item.dimensionId}: ${item.score}`);
    if (!Array.isArray(item.evidence) || !item.evidence.length) throw invalidResponse(`Dimension ${item.dimensionId} has no evidence`);
    coveredDims.add(item.dimensionId);
  }
  for (const id of kb.dimensionIds) {
    if (!coveredDims.has(id)) throw invalidResponse(`Dimension not scored: ${id}`);
  }
  for (const item of raw.improvements || []) {
    if (!['high', 'medium', 'low'].includes(item.priority)) throw invalidResponse(`Invalid improvement priority: ${item.priority}`);
  }

  // 总分由服务端按 rubric 权重确定性重算(消除模型算术误差),模型给出的 overallScore 仅用于偏差告警。
  const weightById = new Map(kb.rubricDimensions.map(d => [d.id, d.weight]));
  const computed = scores.reduce((sum, item) => sum + item.score * (weightById.get(item.dimensionId) || 0), 0);
  const rounded = Math.round(computed * 100) / 100;
  if (typeof raw.overallScore === 'number' && Math.abs(raw.overallScore - rounded) > 0.75) {
    console.warn('[ShotAnalysis]', JSON.stringify({ event: 'overall_score_mismatch', modelReported: raw.overallScore, computed: rounded }));
  }
  raw.overallScore = rounded;
  return raw as ShotAnalysisReport;
}

// 可生产性主报告校验(v1.2):模型只负责非 server 维度。
// - scores 必须且只能覆盖 scoredBy !== 'server' 的维度;发射 server 维度分数判无效响应;
// - shotRisks 禁止出现 server 维度的弱项(multi_character_interaction/pulid_latency);
// - shotRef 强制 "镜头N" 前缀(历史 12 轮出现过 1 轮纯时间戳导致不可解析);
// - overallScore 不在此处计算(等服务端注入 identity 维度分后统一重算)。
export function validateReplicabilityModelReport(raw: any, kb: KnowledgeBase): ReplicabilityReport {
  if (!raw || typeof raw !== 'object') throw invalidResponse('Report is not an object');
  const modelDims = kb.replicabilityDimensions.filter(d => d.scoredBy !== 'server');
  const serverDims = kb.replicabilityDimensions.filter(d => d.scoredBy === 'server');
  const modelDimIds = new Set(modelDims.map(d => d.id));
  const modelWeaknessIds = new Set(modelDims.flatMap(d => d.knownWeaknesses.map(w => w.id)));
  const serverWeaknessIds = new Set(serverDims.flatMap(d => d.knownWeaknesses.map(w => w.id)));

  for (const risk of raw.shotRisks || []) {
    if (serverWeaknessIds.has(risk.weaknessId)) throw invalidResponse(`Model must not emit server-computed weakness in shotRisks: ${risk.weaknessId}`);
    if (!modelWeaknessIds.has(risk.weaknessId)) throw invalidResponse(`Unknown weaknessId: ${risk.weaknessId}`);
    if (!modelDimIds.has(risk.dimensionId)) throw invalidResponse(`Unknown replicability dimensionId in shotRisks: ${risk.dimensionId}`);
    if (!['high', 'medium', 'low'].includes(risk.severity)) throw invalidResponse(`Invalid shotRisk severity: ${risk.severity}`);
    if (!Array.isArray(risk.evidence) || !risk.evidence.length) throw invalidResponse(`ShotRisk ${risk.weaknessId}@${risk.shotRef} has no evidence`);
    if (!/^镜头\s*\d+/.test(String(risk.shotRef || ''))) throw invalidResponse(`ShotRisk shotRef must start with 镜头N, got: ${risk.shotRef}`);
  }
  const scores: DimensionScore[] = raw.scores || [];
  const covered = new Set<string>();
  for (const item of scores) {
    if (!modelDimIds.has(item.dimensionId)) throw invalidResponse(`Model must not score server-computed or unknown dimension: ${item.dimensionId}`);
    if (typeof item.score !== 'number' || ![2, 5, 8, 10].includes(item.score)) throw invalidResponse(`Invalid anchor score for ${item.dimensionId}: ${item.score}; expected one of 2, 5, 8, 10`);
    if (!Array.isArray(item.evidence) || !item.evidence.length) throw invalidResponse(`Dimension ${item.dimensionId} has no evidence`);
    covered.add(item.dimensionId);
  }
  for (const id of modelDimIds) {
    if (!covered.has(id)) throw invalidResponse(`Replicability dimension not scored: ${id}`);
  }
  for (const item of raw.improvements || []) {
    if (!['high', 'medium', 'low'].includes(item.priority)) throw invalidResponse(`Invalid improvement priority: ${item.priority}`);
  }
  return raw as ReplicabilityReport;
}

// 服务端合成 identity 维度(v1.2 第 2/4 节):维度分、evidence、shotRisks、pulid 聚合 advisory
// 与总分重算,全部确定性,模型不参与任何计数或算分。
export function synthesizeServerScoredDimension(
  report: ReplicabilityReport,
  kb: KnowledgeBase,
  dim: ReplicabilityDimension,
  prescreen: PrescreenResult,
  verdicts: AdjudicationVerdict[],
  input: AnalysisJsonInput,
): void {
  const hits = verdicts.filter(v => v.verdict === 'hit');
  const total = prescreen.totalShots;
  const ratio = total > 0 ? hits.length / total : 0;
  const score = ratioToAnchorScore(ratio);
  const nextBand = hitsToNextBand(hits.length, total);
  const pct = (ratio * 100).toFixed(1);
  const candidateByIndex = new Map(prescreen.candidates.map(c => [c.shotIndex, c]));
  const mci = dim.knownWeaknesses.find(w => w.reportLevel !== 'aggregate');
  if (!mci) throw new Error(`Server-scored dimension ${dim.id} has no per-shot weakness to synthesize`);

  report.scores.push({
    dimensionId: dim.id,
    score,
    evidence: [
      `${total} 个镜头中 ${hits.length} 个命中 ${mci.id},占比 ${pct}%(服务端确定性统计:预筛候选 ${prescreen.candidates.length} 个,模型裁决命中 ${hits.length} 个)`,
      hits.length ? `命中镜头:${hits.map(h => `镜头${h.shotIndex}`).join('、')}` : '无命中镜头',
      nextBand !== null
        ? `边界邻近披露:再多 ${nextBand} 个命中镜头即跨入下一分数区间(不做迟滞/平滑,仅披露)`
        : '已在最低分档(占比 > 25%)',
    ],
    reasoning: '服务端确定性计算:候选集、分母、占比、锚点映射与维度分零模型参与;模型仅对封闭候选集逐镜头裁决 hit/no_hit。',
  });

  for (const h of hits) {
    const candidate = candidateByIndex.get(h.shotIndex);
    if (!candidate) continue; // validateVerdicts 已保证封闭域,此分支不可达,仅作类型收窄
    report.shotRisks.push({
      shotRef: `镜头${h.shotIndex} ${candidate.timestamp}`.trim(),
      dimensionId: dim.id,
      weaknessId: mci.id,
      severity: mci.riskLevel,
      evidence: [candidate.description, `裁决依据:${h.reason}`],
      recommendation: mci.recommendation,
    });
  }

  const pulid = dim.knownWeaknesses.find(w => w.reportLevel === 'aggregate');
  if (pulid && total > 0) {
    const locked = countIdentityLockedShots(input.shots, input.characters);
    const lockedRatio = locked / total;
    const threshold = Number(pulid.aggregateThresholdRatio);
    if (lockedRatio > threshold) {
      report.aggregateAdvisories = [
        ...(report.aggregateAdvisories || []),
        {
          dimensionId: dim.id,
          weaknessId: pulid.id,
          numerator: locked,
          denominator: total,
          ratio: Math.round(lockedRatio * 1000) / 1000,
          thresholdRatio: threshold,
          message: `${total} 个镜头中 ${locked} 个为身份锁定镜头(分镜描述含注册角色),占比 ${(lockedRatio * 100).toFixed(1)}% 超过阈值 ${(threshold * 100).toFixed(0)}%,批量生成存在 PuLID 超时/排队风险(服务端聚合统计,不计入维度占比)。`,
          recommendation: pulid.recommendation,
        },
      ];
    }
  }

  report.serverComputed = {
    identityConsistencyPressure: {
      kbLexiconsVersion: kb.replicabilityVersion,
      candidateCount: prescreen.candidates.length,
      totalShots: total,
      hitCount: hits.length,
      ratio: Math.round(ratio * 1000) / 1000,
      hitShotIndexes: hits.map(h => h.shotIndex),
      hitsToNextBand: nextBand,
      verdicts,
    },
  };

  // 总分:identity 分注入后按权重确定性重算。
  const weightById = new Map(kb.replicabilityDimensions.map(d => [d.id, d.weight]));
  const computed = report.scores.reduce((sum, item) => sum + item.score * (weightById.get(item.dimensionId) || 0), 0);
  report.overallScore = Math.round(computed * 100) / 100;
}

type StructuredCallOptions<T> = {
  requestId: string;
  label: string;
  contents: any;
  responseSchema: any;
  timeoutMs: number;
  validate: (parsed: any) => T;
};

// 带重试的结构化调用:解析与业务校验都在重试圈内(无效响应可重试),与 v1.1 行为一致。
async function callGeminiStructured<T>(ai: ReturnType<typeof createGeminiClient>, opts: StructuredCallOptions<T>): Promise<{ result: T; usage: GeminiUsage; attempts: number }> {
  let lastError: any = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const attemptStartedAt = Date.now();
    try {
      console.log('[ShotAnalysis]', JSON.stringify({ requestId: opts.requestId, event: 'attempt_start', call: opts.label, attempt, model: SHOT_ANALYSIS_MODEL, timeoutMs: opts.timeoutMs }));
      const response = await withGeminiTimeout(ai.models.generateContent({
        model: SHOT_ANALYSIS_MODEL,
        contents: opts.contents,
        config: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema: opts.responseSchema,
        },
      }), opts.timeoutMs);
      let parsed: any;
      try {
        parsed = JSON.parse(String(response.text || ''));
      } catch (parseError) {
        throw Object.assign(parseError as Error, { code: 'GEMINI_INVALID_RESPONSE' });
      }
      const result = opts.validate(parsed);
      // usageMetadata 落日志:真实 token 消耗,用于成本核对(验收依赖此字段)。
      const usage: GeminiUsage = {
        promptTokenCount: response.usageMetadata?.promptTokenCount ?? null,
        candidatesTokenCount: response.usageMetadata?.candidatesTokenCount ?? null,
        totalTokenCount: response.usageMetadata?.totalTokenCount ?? null,
      };
      console.log('[ShotAnalysis]', JSON.stringify({ requestId: opts.requestId, event: 'call_success', call: opts.label, attempt, attemptDurationMs: Date.now() - attemptStartedAt, usage }));
      return { result, usage, attempts: attempt };
    } catch (error: any) {
      lastError = error;
      const classified = classifyGeminiError(error);
      console.warn('[ShotAnalysis]', JSON.stringify({ requestId: opts.requestId, event: 'attempt_failed', call: opts.label, attempt, code: classified.code, retryable: classified.retryable, attemptDurationMs: Date.now() - attemptStartedAt, detail: String(error?.message || error) }));
      if (!classified.retryable || attempt === MAX_ATTEMPTS) break;
      await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }
  throw Object.assign(new Error(String(lastError?.message || lastError || `Shot analysis ${opts.label} call failed`)), {
    code: classifyGeminiError(lastError).code,
    cause: lastError,
    requestId: opts.requestId,
  });
}

export async function runShotAnalysis(input: ShotAnalysisInput, analysisType: AnalysisType = 'narrative'): Promise<ShotAnalysisSuccess> {
  const kb = loadKnowledgeBase();
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const timeoutMs = input.sourceType === 'video'
    ? Number(process.env.SHOT_ANALYSIS_VIDEO_TIMEOUT_MS) || 300_000
    : Number(process.env.SHOT_ANALYSIS_TIMEOUT_MS) || 120_000;

  // 可生产性分析只消费分镜 JSON(设计决策:零新增视频调用)。video 输入明确报错,不静默降级。
  if (analysisType === 'replicability' && input.sourceType === 'video') {
    throw Object.assign(
      new Error('Replicability analysis only supports analysis_json input (use videoId of an analyzed library video). Raw video input is not supported for this analysis type.'),
      { code: 'GEMINI_INVALID_RESPONSE', status: 422 },
    );
  }

  const kbVersion = analysisType === 'replicability' ? kb.replicabilityVersion : kb.version;
  const ai = createGeminiClient();

  // --- replicability(v1.2):预筛 → 裁决调用 → 主报告调用 → 服务端合成 ---
  if (analysisType === 'replicability' && input.sourceType === 'analysis_json') {
    const serverDim = kb.replicabilityDimensions.find(d => d.scoredBy === 'server');
    if (!serverDim?.prescreen) throw new Error('replicability rubric has no server-scored dimension; expected identityConsistencyPressure with prescreen config');

    const prescreen = prescreenMultiCharacterShots(input.input.shots, input.input.characters, serverDim.prescreen);
    console.log('[ShotAnalysis]', JSON.stringify({ requestId, event: 'prescreen_done', analysisType, kbVersion, totalShots: prescreen.totalShots, candidateCount: prescreen.candidates.length }));

    // 候选集为空时零裁决调用:hit 数确定为 0,不为空集付一次模型调用。
    let verdicts: AdjudicationVerdict[] = [];
    let adjudicationUsage: GeminiUsage | null = null;
    let adjudicationAttempts = 0;
    if (prescreen.candidates.length > 0) {
      const adjudication = await callGeminiStructured(ai, {
        requestId,
        label: 'adjudication',
        contents: [{ text: buildAdjudicationPrompt(serverDim, prescreen.candidates, input.input.title) }],
        responseSchema: adjudicationResponseSchema,
        timeoutMs,
        validate: parsed => validateVerdicts(parsed, prescreen.candidates),
      });
      verdicts = adjudication.result;
      adjudicationUsage = adjudication.usage;
      adjudicationAttempts = adjudication.attempts;
    }

    const main = await callGeminiStructured(ai, {
      requestId,
      label: 'main_report',
      contents: [{ text: buildReplicabilityPrompt(kb, input.input) }],
      responseSchema: replicabilityResponseSchema,
      timeoutMs,
      validate: parsed => validateReplicabilityModelReport(parsed, kb),
    });

    const report = main.result;
    synthesizeServerScoredDimension(report, kb, serverDim, prescreen, verdicts, input.input);

    const durationMs = Date.now() - startedAt;
    const usage = sumUsage(main.usage, adjudicationUsage);
    const hitCount = verdicts.filter(v => v.verdict === 'hit').length;
    console.log('[ShotAnalysis]', JSON.stringify({ requestId, event: 'success', analysisType, kbVersion, totalDurationMs: durationMs, overallScore: report.overallScore, candidateCount: prescreen.candidates.length, hitCount, usage }));
    return {
      report,
      analysisType,
      kbVersion,
      model: SHOT_ANALYSIS_MODEL,
      requestId,
      attempts: main.attempts,
      durationMs,
      usage,
      usageBreakdown: { main: main.usage, adjudication: adjudicationUsage },
      adjudication: { candidateCount: prescreen.candidates.length, hitCount, attempts: adjudicationAttempts },
    };
  }

  // --- narrative:单次调用,行为与 v1.1 一致 ---
  let uploadedFileName: string | null = null;
  let contents: any;
  if (input.sourceType === 'video') {
    const stat = fs.statSync(input.fullFilePath);
    if (stat.size > MAX_VIDEO_BYTES) {
      // 现有 Gemini 封装不支持长视频分片,超限直接明确报错,不静默降级。
      throw Object.assign(
        new Error(`Video file is ${Math.round(stat.size / 1024 / 1024)}MB, exceeding the ${MAX_VIDEO_BYTES / 1024 / 1024}MB single-file limit of the current Gemini integration.`),
        { code: 'GEMINI_INVALID_RESPONSE', status: 413 },
      );
    }
    const mimeType = videoMimeType(input.filename);
    console.log('[ShotAnalysis]', JSON.stringify({ requestId, event: 'video_upload_start', filename: input.filename, bytes: stat.size }));
    const uploaded = await uploadFileToGemini(ai, input.fullFilePath, mimeType);
    uploadedFileName = uploaded.name;
    contents = [
      { fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType } },
      buildVideoPrompt(kb),
    ];
  } else {
    contents = [{ text: buildAnalysisJsonPrompt(kb, input.input) }];
  }

  try {
    const main = await callGeminiStructured(ai, {
      requestId,
      label: 'main_report',
      contents,
      responseSchema: shotAnalysisResponseSchema,
      timeoutMs,
      validate: parsed => validateReport(parsed, kb),
    });
    const durationMs = Date.now() - startedAt;
    console.log('[ShotAnalysis]', JSON.stringify({ requestId, event: 'success', analysisType, kbVersion, totalDurationMs: durationMs, overallScore: main.result.overallScore, usage: main.usage }));
    return { report: main.result, analysisType, kbVersion, model: SHOT_ANALYSIS_MODEL, requestId, attempts: main.attempts, durationMs, usage: main.usage };
  } finally {
    if (uploadedFileName) await deleteGeminiFile(ai, uploadedFileName);
  }
}
