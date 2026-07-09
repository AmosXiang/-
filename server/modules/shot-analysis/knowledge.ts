// 知识库加载与校验。三个 JSON 文件是分析的唯一事实来源;
// 加载失败或结构不合法直接抛错(不静默降级为空知识库)。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const knowledgeDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'knowledge');

export type HookPattern = {
  id: string;
  name: string;
  definition: string;
  signals: string[];
  timeWindowSeconds: number;
  strengthAnchors: { strong: string; medium: string; weak: string };
  commonFailures: string[];
};

export type DramaPattern = {
  id: string;
  name: string;
  definition: string;
  detectionSignals: string[];
  idealMetrics: Record<string, unknown>;
  deviations: string[];
};

export type RubricDimension = {
  id: string;
  name: string;
  weight: number;
  question: string;
  anchors: Record<string, string>;
  evidenceRequired: boolean;
};

export type KnownWeakness = {
  id: string;
  riskLevel: 'high' | 'medium' | 'low';
  evidenceBasis: string;
  description: string;
  detectionRule: string;
  recommendation: string;
  // v1.2:aggregate 级弱项由服务端聚合统计,不进 shotRisks,模型不得发射。
  reportLevel?: 'aggregate';
  aggregateThresholdRatio?: number;
  aggregateThresholdBasis?: string;
};

export type AdjudicationFewShot = {
  description: string;
  verdict: 'hit' | 'no_hit';
  reason: string;
};

export type ReplicabilityDimension = RubricDimension & {
  metric: string;
  knownWeaknesses: KnownWeakness[];
  explicitNonWeaknesses?: string[];
  calibrationStatus?: string;
  calibrationNote?: string;
  // v1.2:scoredBy === 'server' 的维度由服务端确定性预筛+裁决算分,
  // 主报告调用不再承担其扫描/评分职责(模型输出该维度分数判无效响应)。
  scoredBy?: 'server';
  prescreen?: {
    description: string;
    roleFunctionWords: string[];
    pluralInteractionCues: string[];
  };
  adjudicationFewShots?: AdjudicationFewShot[];
};

export type KnowledgeBase = {
  version: string;
  hookPatterns: HookPattern[];
  dramaPatterns: DramaPattern[];
  rubricDimensions: RubricDimension[];
  hookPatternIds: Set<string>;
  dramaPatternIds: Set<string>;
  dimensionIds: Set<string>;
  replicabilityVersion: string;
  replicabilityDimensions: ReplicabilityDimension[];
  replicabilityDimensionIds: Set<string>;
  replicabilityWeaknessIds: Set<string>;
};

function readKnowledgeFile(filename: string): any {
  const filePath = path.join(knowledgeDir, filename);
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

let cached: KnowledgeBase | null = null;

export function loadKnowledgeBase(): KnowledgeBase {
  if (cached) return cached;

  const hooks = readKnowledgeFile('hook-patterns.json');
  const drama = readKnowledgeFile('drama-patterns.json');
  const rubric = readKnowledgeFile('scoring-rubric.json');
  const replicability = readKnowledgeFile('replicability-rubric.json');

  if (!Array.isArray(hooks.patterns) || !hooks.patterns.length) throw new Error('hook-patterns.json: patterns must be a non-empty array');
  if (!Array.isArray(drama.patterns) || !drama.patterns.length) throw new Error('drama-patterns.json: patterns must be a non-empty array');
  if (!Array.isArray(rubric.dimensions) || !rubric.dimensions.length) throw new Error('scoring-rubric.json: dimensions must be a non-empty array');

  for (const p of hooks.patterns) {
    if (!p.id || !p.name || !p.strengthAnchors?.strong) throw new Error(`hook-patterns.json: invalid pattern ${JSON.stringify(p.id)}`);
  }
  for (const p of drama.patterns) {
    if (!p.id || !p.name || !p.idealMetrics) throw new Error(`drama-patterns.json: invalid pattern ${JSON.stringify(p.id)}`);
  }
  const totalWeight = rubric.dimensions.reduce((sum: number, d: any) => sum + Number(d.weight || 0), 0);
  if (Math.abs(totalWeight - 1) > 1e-6) throw new Error(`scoring-rubric.json: dimension weights must sum to 1, got ${totalWeight}`);
  for (const d of rubric.dimensions) {
    if (!d.id || !d.anchors?.['2'] || !d.anchors?.['10']) throw new Error(`scoring-rubric.json: invalid dimension ${JSON.stringify(d.id)}`);
  }

  if (!Array.isArray(replicability.dimensions) || !replicability.dimensions.length) throw new Error('replicability-rubric.json: dimensions must be a non-empty array');
  const replicabilityWeight = replicability.dimensions.reduce((sum: number, d: any) => sum + Number(d.weight || 0), 0);
  if (Math.abs(replicabilityWeight - 1) > 1e-6) throw new Error(`replicability-rubric.json: dimension weights must sum to 1, got ${replicabilityWeight}`);
  const weaknessIds = new Set<string>();
  for (const d of replicability.dimensions) {
    if (!d.id || !d.anchors?.['2'] || !d.anchors?.['10']) throw new Error(`replicability-rubric.json: invalid dimension ${JSON.stringify(d.id)}`);
    if (!Array.isArray(d.knownWeaknesses)) throw new Error(`replicability-rubric.json: dimension ${d.id} missing knownWeaknesses array`);
    for (const w of d.knownWeaknesses) {
      if (!w.id || !w.evidenceBasis || !w.detectionRule) throw new Error(`replicability-rubric.json: invalid weakness in ${d.id}: ${JSON.stringify(w.id)}`);
      if (weaknessIds.has(w.id)) throw new Error(`replicability-rubric.json: duplicate weakness id ${w.id}`);
      weaknessIds.add(w.id);
      if (w.reportLevel === 'aggregate' && !(Number(w.aggregateThresholdRatio) > 0 && Number(w.aggregateThresholdRatio) < 1)) {
        throw new Error(`replicability-rubric.json: aggregate weakness ${w.id} needs aggregateThresholdRatio in (0,1)`);
      }
    }
    // scoredBy: server 的维度必须带齐服务端预筛与裁决所需的全部字段,缺失即启动失败,不静默降级。
    if (d.scoredBy === 'server') {
      if (!d.prescreen?.roleFunctionWords?.length || !d.prescreen?.pluralInteractionCues?.length) {
        throw new Error(`replicability-rubric.json: server-scored dimension ${d.id} missing prescreen lexicons`);
      }
      if (!Array.isArray(d.adjudicationFewShots) || !d.adjudicationFewShots.length) {
        throw new Error(`replicability-rubric.json: server-scored dimension ${d.id} missing adjudicationFewShots`);
      }
      for (const ex of d.adjudicationFewShots) {
        if (!ex.description || !['hit', 'no_hit'].includes(ex.verdict) || !ex.reason) {
          throw new Error(`replicability-rubric.json: invalid adjudication few-shot in ${d.id}`);
        }
      }
    }
  }

  cached = {
    version: `hook@${hooks.version}+drama@${drama.version}+rubric@${rubric.version}`,
    hookPatterns: hooks.patterns,
    dramaPatterns: drama.patterns,
    rubricDimensions: rubric.dimensions,
    hookPatternIds: new Set(hooks.patterns.map((p: any) => p.id)),
    dramaPatternIds: new Set(drama.patterns.map((p: any) => p.id)),
    dimensionIds: new Set(rubric.dimensions.map((d: any) => d.id)),
    replicabilityVersion: `replicability@${replicability.version}`,
    replicabilityDimensions: replicability.dimensions,
    replicabilityDimensionIds: new Set(replicability.dimensions.map((d: any) => d.id)),
    replicabilityWeaknessIds: weaknessIds,
  };
  return cached;
}
