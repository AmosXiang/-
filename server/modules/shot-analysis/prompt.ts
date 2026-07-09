// 构建拉片分析 prompt。知识库全文嵌入 prompt,配合 responseSchema 结构化输出。
// 可复现性要点:封闭 id 域 + 锚定量表 + 证据先行,见 docs/shot-analysis/DESIGN.md。

import type { KnowledgeBase } from './knowledge.ts';

export type AnalysisJsonInput = {
  title: string;
  genre?: string;
  shots: Array<{ timestamp: string; timeSeconds: number; movement: string; composition: string; emotion: string; description: string }>;
  characters: Array<{ name: string; role: string; personality?: string; clothing?: string }>;
  narrative?: { structure?: string; rhythm?: string; climaxDesign?: string };
};

function knowledgeSection(kb: KnowledgeBase): string {
  return `【知识库 A:开场钩子模式(hookPatterns)】
${JSON.stringify(kb.hookPatterns, null, 1)}

【知识库 B:剧情结构与节奏模式(dramaPatterns)】
${JSON.stringify(kb.dramaPatterns, null, 1)}

【知识库 C:评分维度(scoringRubric)】
${JSON.stringify(kb.rubricDimensions, null, 1)}`;
}

function rulesSection(kb: KnowledgeBase): string {
  return `【分析规则(必须严格遵守)】
1. patternId 只能取自知识库 A/B 中列出的 id,dimensionId 只能取自知识库 C 中列出的 id。禁止发明新 id。
   合法 hook patternId:${[...kb.hookPatternIds].join(', ')}
   合法 drama patternId:${[...kb.dramaPatternIds].join(', ')}
   合法 dimensionId:${[...kb.dimensionIds].join(', ')}
2. 证据先行:每个钩子命中、每个结构判定、每个维度评分都必须先引用具体证据
   (时间戳或镜头,格式如 "00:03 台词:xxx" 或 "镜头2 00:07-00:27:xxx"),再下结论。无证据不得输出该项。
3. 评分必须对照知识库 C 中该维度的 anchors(2/5/8/10 的行为化描述)定标,
   分数落在两个锚点之间时取中间值。禁止凭整体印象打分。
4. 钩子强度(strong/medium/weak)必须对照该模式的 strengthAnchors 判定。
5. 只报告有证据支持的钩子模式,没有命中的模式不要输出。
6. structureAnalysis.detectedPatterns 必须覆盖知识库 B 的全部 6 个模式,逐一判定 conforms 并给出证据。
7. improvements 按 priority 排序,每条必须指向具体时间戳/镜头(target),并给出 relatedPatternId 便于追溯。
8. 全部输出使用中文。`;
}

export function buildAnalysisJsonPrompt(kb: KnowledgeBase, input: AnalysisJsonInput): string {
  return `你是一位专业的中文竖屏短剧拉片分析师。下面提供:(1) 拉片知识库;(2) 一部短剧的结构化分镜数据。
请基于知识库对该短剧执行拉片分析,严格按照提供的 JSON Schema 输出报告。

${knowledgeSection(kb)}

${rulesSection(kb)}

【待分析短剧】
标题:${input.title}
类型:${input.genre || '未标注'}
人物:
${JSON.stringify(input.characters, null, 1)}
叙事概要:
${JSON.stringify(input.narrative || {}, null, 1)}
分镜列表(共 ${input.shots.length} 个镜头,timeSeconds 为该镜头起始秒数):
${JSON.stringify(input.shots, null, 1)}`;
}

// v1.3:主调用瘦身。全部四个维度的 scores/shotRisks 由服务端预筛+裁决产出,
// 主调用只基于服务端统计撰写 improvements 与 summary(保证叙述与数字一致)。
export type ServerStatsForNarrative = Array<{
  dimensionId: string;
  dimensionName: string;
  score: number;
  hitCount: number;
  totalShots: number;
  ratioPercent: string;
  hitShots: Array<{ shotIndex: number; weaknessId: string; reason: string }>;
}>;

export function buildReplicabilityPrompt(kb: KnowledgeBase, input: AnalysisJsonInput, serverStats: ServerStatsForNarrative, overallScore: number, advisories: string[]): string {
  const allIds = kb.replicabilityDimensions.flatMap(d => [d.id, ...d.knownWeaknesses.map(w => w.id)]);
  return `你是本项目 AI 短剧生产链路(ComfyUI 静帧生成 + 8 秒视频片段生成 + 后期合成)的可生产性评估专家。
四个维度的评分与命中镜头已由服务端确定性计算完毕(见下)。你的任务只有两个:
(1) improvements:针对命中镜头给出可执行的改写/拆分/后期标注建议;(2) summary:一段中文总评。
严格按照提供的 JSON Schema 输出,不要输出任何分数或风险列表。

【知识库:可生产性评分维度(replicabilityRubric,供理解弱项与 recommendation 基调)】
${JSON.stringify(kb.replicabilityDimensions.map(d => ({ id: d.id, name: d.name, weight: d.weight, question: d.question, knownWeaknesses: d.knownWeaknesses.map(w => ({ id: w.id, riskLevel: w.riskLevel, description: w.description, recommendation: w.recommendation })), explicitNonWeaknesses: d.explicitNonWeaknesses, calibrationStatus: d.calibrationStatus })), null, 1)}

【服务端已算定的评分与命中清单(不可更改,叙述必须与这些数字一致)】
overallScore:${overallScore}
${JSON.stringify(serverStats, null, 1)}
${advisories.length ? `聚合提示:\n${advisories.map(a => `- ${a}`).join('\n')}` : ''}

【输出规则(必须严格遵守)】
1. improvements 按 priority 排序;镜头级建议的 target 必须以"镜头N"开头(N 为分镜列表 1 起序号),
   跨镜头的整体性建议 target 以"全剧"或"整体"开头;relatedPatternId 只能取自:${allIds.join(', ')}。
2. improvements 优先覆盖 riskLevel 高、命中数多的弱项;suggestion 基于知识库该弱项的 recommendation 针对具体镜头细化。
3. explicitNonWeaknesses 中声明的内容(如复杂手部动作)不是弱项,禁止出现在 improvements 中。
4. 运镜可行性维度 calibrationStatus: unverified——所有文字中禁止出现具体成功率/失败率数字。
5. summary 需与服务端分数一致地概括整体可生产性结论与最需要处理的风险。
6. 全部输出使用中文。

【待评估短剧分镜(供 improvements 定位镜头)】
标题:${input.title}
类型:${input.genre || '未标注'}
人物:
${JSON.stringify(input.characters, null, 1)}
分镜列表(共 ${input.shots.length} 个镜头,timeSeconds 为该镜头起始秒数):
${JSON.stringify(input.shots, null, 1)}`;
}

export function buildVideoPrompt(kb: KnowledgeBase): string {
  return `你是一位专业的中文竖屏短剧拉片分析师。请仔细观看附带的视频,基于下面的拉片知识库执行拉片分析,严格按照提供的 JSON Schema 输出报告。

${knowledgeSection(kb)}

${rulesSection(kb)}

【补充要求】证据中的时间戳必须与视频实际画面对齐,精确到秒。`;
}
