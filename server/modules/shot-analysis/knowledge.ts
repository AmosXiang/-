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

export type KnowledgeBase = {
  version: string;
  hookPatterns: HookPattern[];
  dramaPatterns: DramaPattern[];
  rubricDimensions: RubricDimension[];
  hookPatternIds: Set<string>;
  dramaPatternIds: Set<string>;
  dimensionIds: Set<string>;
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

  cached = {
    version: `hook@${hooks.version}+drama@${drama.version}+rubric@${rubric.version}`,
    hookPatterns: hooks.patterns,
    dramaPatterns: drama.patterns,
    rubricDimensions: rubric.dimensions,
    hookPatternIds: new Set(hooks.patterns.map((p: any) => p.id)),
    dramaPatternIds: new Set(drama.patterns.map((p: any) => p.id)),
    dimensionIds: new Set(rubric.dimensions.map((d: any) => d.id)),
  };
  return cached;
}
