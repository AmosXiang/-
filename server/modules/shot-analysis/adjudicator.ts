// rubric v1.2 裁决调用:模型对服务端预筛出的封闭候选集逐镜头表态 hit/no_hit。
// 强制逐候选表态(每个候选 index 恰好出现一次,缺一即无效响应),杜绝自由扫描的懒扫描
// 计数崩塌;禁止提名候选外镜头(审计表明候选外标记几乎全是过标或无据猜测)。

import type { ReplicabilityDimension } from './knowledge.ts';
import type { ShotCandidate } from './prescreen.ts';

export type AdjudicationVerdict = {
  shotIndex: number;
  verdict: 'hit' | 'no_hit';
  reason: string;
};

export const adjudicationResponseSchema = {
  type: 'OBJECT',
  properties: {
    verdicts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          shotIndex: { type: 'INTEGER', description: '候选镜头编号,必须来自输入候选列表' },
          verdict: { type: 'STRING', description: 'hit | no_hit' },
          reason: { type: 'STRING', description: '一句话裁决依据,引用描述原文关键词' },
        },
        required: ['shotIndex', 'verdict', 'reason'],
      },
    },
  },
  required: ['verdicts'],
} as const;

export function buildAdjudicationPrompt(dim: ReplicabilityDimension, candidates: ShotCandidate[], title: string): string {
  const fewShots = (dim.adjudicationFewShots || [])
    .map((ex, i) => `示例${i + 1}:「${ex.description}」→ ${ex.verdict}。${ex.reason}`)
    .join('\n');
  const candidateList = candidates.map(c => ({ shotIndex: c.shotIndex, timestamp: c.timestamp, description: c.description }));
  return `你是本项目 AI 短剧生产链路的可生产性评估专家。下面是短剧《${title}》分镜中由服务端预筛出的候选镜头列表。
请对每一个候选镜头独立裁决:它是否构成「多人同框互动」(hit),还是不构成(no_hit)。

【判定口径(必须严格遵守)】
${dim.metric}

【边界示例(来自真实库内镜头)】
${fewShots}

【裁决规则】
1. verdicts 必须覆盖下面列出的每一个候选镜头,一个不多、一个不少;每个 shotIndex 恰好出现一次。
2. 只允许对候选列表中的镜头表态,禁止提名列表之外的任何镜头。
3. 每条裁决只依据该镜头自身的 description 文本判定,不得引入其他镜头的上下文推断画面内容。
4. reason 用一句中文说明依据,引用描述原文关键词。
5. 拿不准时按判定口径的排除条款处理:正反打单人画面、仅台词提及、背景无名路人均为 no_hit。

【候选镜头列表(共 ${candidates.length} 个)】
${JSON.stringify(candidateList, null, 1)}`;
}

// 服务端校验:候选封闭域 + 每个候选恰好一次 + verdict 枚举合法。
// 违反任何一条都判 GEMINI_INVALID_RESPONSE(由调用方包装),不静默修补。
export function validateVerdicts(raw: any, candidates: ShotCandidate[]): AdjudicationVerdict[] {
  const fail = (detail: string): never => {
    throw Object.assign(new Error(detail), { code: 'GEMINI_INVALID_RESPONSE' });
  };
  if (!raw || !Array.isArray(raw.verdicts)) fail('Adjudication response has no verdicts array');
  const expected = new Set(candidates.map(c => c.shotIndex));
  const seen = new Set<number>();
  const verdicts: AdjudicationVerdict[] = [];
  for (const item of raw.verdicts) {
    const shotIndex = Number(item?.shotIndex);
    if (!expected.has(shotIndex)) fail(`Adjudication verdict for non-candidate shot: ${item?.shotIndex}`);
    if (seen.has(shotIndex)) fail(`Duplicate adjudication verdict for shot ${shotIndex}`);
    seen.add(shotIndex);
    if (item.verdict !== 'hit' && item.verdict !== 'no_hit') fail(`Invalid verdict for shot ${shotIndex}: ${item?.verdict}`);
    if (typeof item.reason !== 'string' || !item.reason.trim()) fail(`Missing adjudication reason for shot ${shotIndex}`);
    verdicts.push({ shotIndex, verdict: item.verdict, reason: item.reason.trim() });
  }
  for (const idx of expected) {
    if (!seen.has(idx)) fail(`Adjudication verdict missing for candidate shot ${idx}`);
  }
  return verdicts.sort((a, b) => a.shotIndex - b.shotIndex);
}
