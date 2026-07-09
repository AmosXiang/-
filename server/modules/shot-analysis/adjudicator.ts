// rubric v1.2/v1.3 裁决调用:模型对服务端预筛出的封闭 (镜头, 弱项) 对逐一表态 hit/no_hit。
// 强制逐对表态(每对恰好出现一次,缺一即无效响应),杜绝自由扫描的懒扫描计数崩塌;
// 禁止提名候选外的镜头或弱项(审计表明候选外标记几乎全是过标或无据猜测)。
// v1.3 将裁决域从 identity 单维度扩展为全部 server-scored 维度,单次调用完成。

import type { ReplicabilityDimension } from './knowledge.ts';

export type AdjudicationPair = {
  shotIndex: number; // 1-based,与报告中"镜头N"一致(服务端编号,消除模型 off-by-one)
  weaknessId: string;
  timestamp: string;
  movement?: string;
  description: string;
};

export type AdjudicationGroup = {
  dim: ReplicabilityDimension;
  pairs: AdjudicationPair[];
};

export type AdjudicationVerdict = {
  shotIndex: number;
  weaknessId: string;
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
          weaknessId: { type: 'STRING', description: '必须与该候选对的 weaknessId 一致' },
          verdict: { type: 'STRING', description: 'hit | no_hit' },
          reason: { type: 'STRING', description: '一句话裁决依据,引用 movement/description 原文关键词' },
        },
        required: ['shotIndex', 'weaknessId', 'verdict', 'reason'],
      },
    },
  },
  required: ['verdicts'],
} as const;

function renderFewShots(dim: ReplicabilityDimension): string {
  return (dim.adjudicationFewShots || [])
    .map((ex, i) => {
      const movement = ex.movement ? `movement:「${ex.movement}」,` : '';
      return `示例${i + 1}(${ex.weaknessId}):${movement}「${ex.description}」→ ${ex.verdict}。${ex.reason}`;
    })
    .join('\n');
}

function renderGroup(group: AdjudicationGroup): string {
  const { dim, pairs } = group;
  const weaknessRules = dim.knownWeaknesses
    .filter(w => w.reportLevel !== 'aggregate')
    .map(w => `- ${w.id}:${w.description}\n  裁决口径:${w.detectionRule}`)
    .join('\n');
  const pairList = pairs.map(p => ({
    shotIndex: p.shotIndex,
    weaknessId: p.weaknessId,
    timestamp: p.timestamp,
    ...(p.movement ? { movement: p.movement } : {}),
    description: p.description,
  }));
  const calibration = dim.calibrationStatus === 'unverified'
    ? `\n注意:本维度 calibrationStatus: unverified——reason 中禁止出现任何具体成功率/失败率数字,只作特征判定。`
    : '';
  return `【维度:${dim.name}(${dim.id})】
判定口径(metric):${dim.metric}
弱项定义:
${weaknessRules}${calibration}

边界示例(来自真实库内镜头):
${renderFewShots(dim)}

候选 (镜头, 弱项) 对(共 ${pairs.length} 个):
${JSON.stringify(pairList, null, 1)}`;
}

export function buildAdjudicationPrompt(groups: AdjudicationGroup[], title: string): string {
  const totalPairs = groups.reduce((sum, g) => sum + g.pairs.length, 0);
  return `你是本项目 AI 短剧生产链路(ComfyUI 静帧 + 8 秒视频片段 + 后期合成)的可生产性评估专家。
下面是短剧《${title}》分镜中由服务端预筛出的候选 (镜头, 弱项) 对,按维度分组。
请对每一对独立裁决:该镜头是否命中该弱项(hit),还是不命中(no_hit)。

${groups.map(renderGroup).join('\n\n')}

【裁决规则(必须严格遵守)】
1. verdicts 必须覆盖上面列出的每一个 (shotIndex, weaknessId) 对,一个不多、一个不少;每对恰好出现一次。
2. 只允许对候选列表中的对表态,禁止提名列表之外的任何镜头或弱项。全部候选对共 ${totalPairs} 个。
3. 每条裁决只依据该镜头自身的 movement/description 文本判定,不得引入其他镜头的上下文推断画面内容。
4. reason 用一句中文说明依据,引用原文关键词。
5. 拿不准时按各维度判定口径的排除条款处理(如:正反打单人画面、仅台词提及、无需辨认内容的屏幕物件、单一运动矢量,均为 no_hit)。
6. 同一镜头可能出现在多个弱项对中,各对独立裁决,互不影响。`;
}

// 服务端校验:候选封闭域 + 每对恰好一次 + verdict 枚举合法。
// 违反任何一条都判 GEMINI_INVALID_RESPONSE(由调用方包装),不静默修补。
export function validateVerdicts(raw: any, pairs: AdjudicationPair[]): AdjudicationVerdict[] {
  const fail = (detail: string): never => {
    throw Object.assign(new Error(detail), { code: 'GEMINI_INVALID_RESPONSE' });
  };
  if (!raw || !Array.isArray(raw.verdicts)) fail('Adjudication response has no verdicts array');
  const keyOf = (shotIndex: number, weaknessId: string) => `${shotIndex}:${weaknessId}`;
  const expected = new Set(pairs.map(p => keyOf(p.shotIndex, p.weaknessId)));
  const seen = new Set<string>();
  const verdicts: AdjudicationVerdict[] = [];
  for (const item of raw.verdicts) {
    const shotIndex = Number(item?.shotIndex);
    const weaknessId = String(item?.weaknessId || '');
    const key = keyOf(shotIndex, weaknessId);
    if (!expected.has(key)) fail(`Adjudication verdict for non-candidate pair: ${key}`);
    if (seen.has(key)) fail(`Duplicate adjudication verdict for pair ${key}`);
    seen.add(key);
    if (item.verdict !== 'hit' && item.verdict !== 'no_hit') fail(`Invalid verdict for pair ${key}: ${item?.verdict}`);
    if (typeof item.reason !== 'string' || !item.reason.trim()) fail(`Missing adjudication reason for pair ${key}`);
    verdicts.push({ shotIndex, weaknessId, verdict: item.verdict, reason: item.reason.trim() });
  }
  for (const key of expected) {
    if (!seen.has(key)) fail(`Adjudication verdict missing for candidate pair ${key}`);
  }
  return verdicts.sort((a, b) => a.shotIndex - b.shotIndex || a.weaknessId.localeCompare(b.weaknessId));
}
