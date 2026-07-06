// 拉片分析核心。复用 server/lib/gemini.ts 中提取自 server.ts 的既有封装:
// 每次调用构造客户端、withGeminiTimeout、classifyGeminiError、maxAttempts=2 + 500*attempt 退避、
// 视频走 Files API 上传-轮询-清理。失败语义:类型化错误直接抛出,任何路径不产出编造的报告。

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
import { loadKnowledgeBase, type KnowledgeBase } from './knowledge.ts';
import { buildAnalysisJsonPrompt, buildReplicabilityPrompt, buildVideoPrompt, type AnalysisJsonInput } from './prompt.ts';
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
};

function invalidResponse(detail: string): Error {
  return Object.assign(new Error(detail), { code: 'GEMINI_INVALID_RESPONSE' });
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

// 可生产性报告校验:封闭 id 域(dimension/weakness)+ 全维度覆盖 + 证据必填 + 服务端重算总分。
function validateReplicabilityReport(raw: any, kb: KnowledgeBase): ReplicabilityReport {
  if (!raw || typeof raw !== 'object') throw invalidResponse('Report is not an object');
  for (const risk of raw.shotRisks || []) {
    if (!kb.replicabilityDimensionIds.has(risk.dimensionId)) throw invalidResponse(`Unknown replicability dimensionId in shotRisks: ${risk.dimensionId}`);
    if (!kb.replicabilityWeaknessIds.has(risk.weaknessId)) throw invalidResponse(`Unknown weaknessId: ${risk.weaknessId}`);
    if (!['high', 'medium', 'low'].includes(risk.severity)) throw invalidResponse(`Invalid shotRisk severity: ${risk.severity}`);
    if (!Array.isArray(risk.evidence) || !risk.evidence.length) throw invalidResponse(`ShotRisk ${risk.weaknessId}@${risk.shotRef} has no evidence`);
  }
  const scores: DimensionScore[] = raw.scores || [];
  const covered = new Set<string>();
  for (const item of scores) {
    if (!kb.replicabilityDimensionIds.has(item.dimensionId)) throw invalidResponse(`Unknown replicability dimensionId: ${item.dimensionId}`);
    if (typeof item.score !== 'number' || ![2, 5, 8, 10].includes(item.score)) throw invalidResponse(`Invalid anchor score for ${item.dimensionId}: ${item.score}; expected one of 2, 5, 8, 10`);
    if (!Array.isArray(item.evidence) || !item.evidence.length) throw invalidResponse(`Dimension ${item.dimensionId} has no evidence`);
    covered.add(item.dimensionId);
  }
  for (const id of kb.replicabilityDimensionIds) {
    if (!covered.has(id)) throw invalidResponse(`Replicability dimension not scored: ${id}`);
  }
  for (const item of raw.improvements || []) {
    if (!['high', 'medium', 'low'].includes(item.priority)) throw invalidResponse(`Invalid improvement priority: ${item.priority}`);
  }
  const weightById = new Map(kb.replicabilityDimensions.map(d => [d.id, d.weight]));
  const computed = scores.reduce((sum, item) => sum + item.score * (weightById.get(item.dimensionId) || 0), 0);
  const rounded = Math.round(computed * 100) / 100;
  if (typeof raw.overallScore === 'number' && Math.abs(raw.overallScore - rounded) > 0.75) {
    console.warn('[ShotAnalysis]', JSON.stringify({ event: 'overall_score_mismatch', analysisType: 'replicability', modelReported: raw.overallScore, computed: rounded }));
  }
  raw.overallScore = rounded;
  return raw as ReplicabilityReport;
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
  const responseSchema = analysisType === 'replicability' ? replicabilityResponseSchema : shotAnalysisResponseSchema;

  const ai = createGeminiClient();

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
    contents = [{ text: analysisType === 'replicability' ? buildReplicabilityPrompt(kb, input.input) : buildAnalysisJsonPrompt(kb, input.input) }];
  }

  try {
    let lastError: any = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const attemptStartedAt = Date.now();
      try {
        console.log('[ShotAnalysis]', JSON.stringify({ requestId, event: 'attempt_start', attempt, model: SHOT_ANALYSIS_MODEL, analysisType, sourceType: input.sourceType, kbVersion, timeoutMs }));
        const response = await withGeminiTimeout(ai.models.generateContent({
          model: SHOT_ANALYSIS_MODEL,
          contents,
          config: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseSchema,
          },
        }), timeoutMs);
        let parsed: any;
        try {
          parsed = JSON.parse(String(response.text || ''));
        } catch (parseError) {
          throw Object.assign(parseError as Error, { code: 'GEMINI_INVALID_RESPONSE' });
        }
        const report = analysisType === 'replicability' ? validateReplicabilityReport(parsed, kb) : validateReport(parsed, kb);
        const durationMs = Date.now() - startedAt;
        // usageMetadata 落日志:真实 token 消耗,用于成本核对(commit C 验收依赖此字段)。
        const usage: GeminiUsage = {
          promptTokenCount: response.usageMetadata?.promptTokenCount ?? null,
          candidatesTokenCount: response.usageMetadata?.candidatesTokenCount ?? null,
          totalTokenCount: response.usageMetadata?.totalTokenCount ?? null,
        };
        console.log('[ShotAnalysis]', JSON.stringify({ requestId, event: 'success', attempt, analysisType, attemptDurationMs: Date.now() - attemptStartedAt, totalDurationMs: durationMs, overallScore: report.overallScore, usage }));
        return { report, analysisType, kbVersion, model: SHOT_ANALYSIS_MODEL, requestId, attempts: attempt, durationMs, usage };
      } catch (error: any) {
        lastError = error;
        const classified = classifyGeminiError(error);
        console.warn('[ShotAnalysis]', JSON.stringify({ requestId, event: 'attempt_failed', attempt, code: classified.code, retryable: classified.retryable, attemptDurationMs: Date.now() - attemptStartedAt, detail: String(error?.message || error) }));
        if (!classified.retryable || attempt === MAX_ATTEMPTS) break;
        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
      }
    }
    throw Object.assign(new Error(String(lastError?.message || lastError || 'Shot analysis failed')), {
      code: classifyGeminiError(lastError).code,
      cause: lastError,
      requestId,
    });
  } finally {
    if (uploadedFileName) await deleteGeminiFile(ai, uploadedFileName);
  }
}
