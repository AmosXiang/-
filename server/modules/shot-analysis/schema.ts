// 拉片分析报告的 TypeScript 类型与 Gemini responseSchema。
// responseSchema 采用与 server.ts 现有调用一致的大写类型风格('OBJECT'/'STRING'/...),
// 并与 knowledge/ 下的三个知识库文件(hook-patterns / drama-patterns / scoring-rubric)对应。

export type HookPatternMatch = {
  patternId: string;
  patternName: string;
  strength: 'strong' | 'medium' | 'weak';
  evidence: string[];
  comment: string;
};

export type DramaPatternMatch = {
  patternId: string;
  patternName: string;
  conforms: boolean;
  evidence: string[];
  deviation: string;
};

export type DimensionScore = {
  dimensionId: string;
  score: number;
  evidence: string[];
  reasoning: string;
};

export type Improvement = {
  priority: 'high' | 'medium' | 'low';
  target: string;
  issue: string;
  suggestion: string;
  relatedPatternId: string;
};

export type ShotAnalysisReport = {
  hookAnalysis: {
    windowSeconds: number;
    detectedPatterns: HookPatternMatch[];
    overallComment: string;
  };
  structureAnalysis: {
    detectedPatterns: DramaPatternMatch[];
    reversals: Array<{ timeSeconds: number; type: string; description: string }>;
    overallComment: string;
  };
  scores: DimensionScore[];
  overallScore: number;
  improvements: Improvement[];
  summary: string;
};

// --- 本链路可生产性(replicability)分析 ---
// 对应 knowledge/replicability-rubric.json。回答"这套分镜我们的链路能不能做出来",
// 与叙事质量分析(上方)正交。weaknessId/dimensionId 为封闭 id 域,服务端校验。

export type ShotRisk = {
  shotRef: string;
  dimensionId: string;
  weaknessId: string;
  severity: 'high' | 'medium' | 'low';
  evidence: string[];
  recommendation: string;
};

// v1.2:aggregate 级弱项(pulid_latency)的报告顶层提示,由服务端聚合统计产出,不进 shotRisks。
export type AggregateAdvisory = {
  dimensionId: string;
  weaknessId: string;
  numerator: number;
  denominator: number;
  ratio: number;
  thresholdRatio: number;
  message: string;
  recommendation: string;
};

// v1.2:服务端确定性计算的过程数据,随报告落库,供消费方核查与复验对账。
export type ServerComputedIdentity = {
  kbLexiconsVersion: string;
  candidateCount: number;
  totalShots: number;
  hitCount: number;
  ratio: number;
  hitShotIndexes: number[];
  hitsToNextBand: number | null;
  verdicts: Array<{ shotIndex: number; verdict: 'hit' | 'no_hit'; reason: string }>;
};

export type ReplicabilityReport = {
  shotRisks: ShotRisk[];
  scores: DimensionScore[];
  overallScore: number;
  improvements: Improvement[];
  summary: string;
  aggregateAdvisories?: AggregateAdvisory[];
  serverComputed?: { identityConsistencyPressure: ServerComputedIdentity };
};

export type ShotAnalysisReportRow = {
  id: string;
  videoId: string | null;
  sourceType: 'video' | 'analysis_json';
  analysisType: 'narrative' | 'replicability';
  sourceRef: string;
  kbVersion: string;
  model: string;
  requestId: string;
  status: 'succeeded' | 'failed';
  reportJson: string | null;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
};

// Gemini 结构化输出 schema。字段与 ShotAnalysisReport 一一对应。
export const shotAnalysisResponseSchema = {
  type: 'OBJECT',
  properties: {
    hookAnalysis: {
      type: 'OBJECT',
      properties: {
        windowSeconds: { type: 'INTEGER', description: '实际用于钩子判定的开场窗口秒数' },
        detectedPatterns: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              patternId: { type: 'STRING', description: '必须是知识库 hook-patterns 中的 pattern id' },
              patternName: { type: 'STRING' },
              strength: { type: 'STRING', description: 'strong | medium | weak,按该模式的 strengthAnchors 判定' },
              evidence: { type: 'ARRAY', items: { type: 'STRING' }, description: '证据,必须引用具体时间戳或镜头,如 "00:03 台词:..."' },
              comment: { type: 'STRING' },
            },
            required: ['patternId', 'patternName', 'strength', 'evidence', 'comment'],
          },
        },
        overallComment: { type: 'STRING' },
      },
      required: ['windowSeconds', 'detectedPatterns', 'overallComment'],
    },
    structureAnalysis: {
      type: 'OBJECT',
      properties: {
        detectedPatterns: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              patternId: { type: 'STRING', description: '必须是知识库 drama-patterns 中的 pattern id' },
              patternName: { type: 'STRING' },
              conforms: { type: 'BOOLEAN', description: '是否符合该模式的 idealMetrics' },
              evidence: { type: 'ARRAY', items: { type: 'STRING' } },
              deviation: { type: 'STRING', description: '若不符合,说明偏差;符合则为空字符串' },
            },
            required: ['patternId', 'patternName', 'conforms', 'evidence', 'deviation'],
          },
        },
        reversals: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              timeSeconds: { type: 'INTEGER' },
              type: { type: 'STRING', description: '反转类型:身份揭晓/证据出现/外援到场/立场倒戈/其他' },
              description: { type: 'STRING' },
            },
            required: ['timeSeconds', 'type', 'description'],
          },
        },
        overallComment: { type: 'STRING' },
      },
      required: ['detectedPatterns', 'reversals', 'overallComment'],
    },
    scores: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          dimensionId: { type: 'STRING', description: '必须是知识库 scoring-rubric 中的 dimension id' },
          score: { type: 'NUMBER', description: '0-10,必须依据该维度 anchors 定标' },
          evidence: { type: 'ARRAY', items: { type: 'STRING' }, description: '必须先列证据(时间戳/镜头)再给分' },
          reasoning: { type: 'STRING' },
        },
        required: ['dimensionId', 'score', 'evidence', 'reasoning'],
      },
    },
    overallScore: { type: 'NUMBER', description: '按 rubric 权重的加权平均,0-10' },
    improvements: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          priority: { type: 'STRING', description: 'high | medium | low' },
          target: { type: 'STRING', description: '指向具体时间戳或镜头范围' },
          issue: { type: 'STRING' },
          suggestion: { type: 'STRING' },
          relatedPatternId: { type: 'STRING', description: '关联的知识库 pattern/dimension id,便于追溯' },
        },
        required: ['priority', 'target', 'issue', 'suggestion', 'relatedPatternId'],
      },
    },
    summary: { type: 'STRING', description: '一段中文总评' },
  },
  required: ['hookAnalysis', 'structureAnalysis', 'scores', 'overallScore', 'improvements', 'summary'],
} as const;

// 可生产性报告的 Gemini 结构化输出 schema。与 ReplicabilityReport 一一对应。
export const replicabilityResponseSchema = {
  type: 'OBJECT',
  properties: {
    shotRisks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          shotRef: { type: 'STRING', description: '指向具体镜头,如 "镜头12 01:23-01:31"' },
          dimensionId: { type: 'STRING', description: '必须是 replicability-rubric 中的 dimension id' },
          weaknessId: { type: 'STRING', description: '必须是该维度 knownWeaknesses 中的 weakness id' },
          severity: { type: 'STRING', description: 'high | medium | low' },
          evidence: { type: 'ARRAY', items: { type: 'STRING' }, description: '引用分镜描述原文片段作为证据' },
          recommendation: { type: 'STRING', description: '按知识库该弱项的 recommendation 给出针对本镜头的具体建议' },
        },
        required: ['shotRef', 'dimensionId', 'weaknessId', 'severity', 'evidence', 'recommendation'],
      },
    },
    scores: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          dimensionId: { type: 'STRING', description: '必须是 replicability-rubric 中的 dimension id' },
          score: { type: 'NUMBER', description: '0-10,必须依据该维度 anchors 定标,高分=易生产' },
          evidence: { type: 'ARRAY', items: { type: 'STRING' }, description: '必须先列证据(镜头引用/占比统计)再给分' },
          reasoning: { type: 'STRING' },
        },
        required: ['dimensionId', 'score', 'evidence', 'reasoning'],
      },
    },
    overallScore: { type: 'NUMBER', description: '按 rubric 权重的加权平均,0-10(服务端会重算)' },
    improvements: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          priority: { type: 'STRING', description: 'high | medium | low' },
          target: { type: 'STRING', description: '指向具体镜头或镜头范围' },
          issue: { type: 'STRING' },
          suggestion: { type: 'STRING' },
          relatedPatternId: { type: 'STRING', description: '关联的 dimension/weakness id,便于追溯' },
        },
        required: ['priority', 'target', 'issue', 'suggestion', 'relatedPatternId'],
      },
    },
    summary: { type: 'STRING', description: '一段中文总评:整体可生产性结论与最需要处理的风险' },
  },
  required: ['shotRisks', 'scores', 'overallScore', 'improvements', 'summary'],
} as const;
