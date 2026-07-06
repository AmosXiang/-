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

export function buildReplicabilityPrompt(kb: KnowledgeBase, input: AnalysisJsonInput): string {
  return `你是本项目 AI 短剧生产链路(ComfyUI 静帧生成 + 8 秒视频片段生成 + 后期合成)的可生产性评估专家。
下面提供:(1) 可生产性评估知识库;(2) 一部短剧的结构化分镜数据。
请评估这套分镜在本链路上的可生产性,严格按照提供的 JSON Schema 输出报告。

【知识库:可生产性评分维度(replicabilityRubric)】
${JSON.stringify(kb.replicabilityDimensions, null, 1)}

【评估规则(必须严格遵守)】
1. dimensionId 只能取自知识库中列出的维度 id,weaknessId 只能取自对应维度 knownWeaknesses 中的 id。禁止发明新 id。
   合法 dimensionId:${[...kb.replicabilityDimensionIds].join(', ')}
   合法 weaknessId:${[...kb.replicabilityWeaknessIds].join(', ')}
2. shotRisks:逐镜头对照每个弱项的 detectionRule 检查,命中才输出,证据必须引用分镜描述原文片段与镜头时间戳。
   没有命中任何弱项的镜头不要输出。recommendation 必须基于该弱项知识库中的 recommendation 并针对具体镜头细化。
3. 评分必须严格执行以下四步流程:先按该维度 metric 统计分子/分母并写入 evidence(格式:"74 个镜头中 6 个命中 text_in_frame,占比 8.1%"),再按占比落入 anchors 数值区间取对应锚点分。分数只允许 2/5/8/10 四个取值;区间边界严格按 ≤/< 记号判定;禁止区间映射之外的加减分。高分 = 易生产。
4. explicitNonWeaknesses 中声明的内容(如复杂手部动作)不是弱项,禁止据此标记风险或扣分。
5. 标注了 calibrationStatus: unverified 的维度(运镜可行性)只能给出定性判断与拆分建议,禁止在任何文字中出现具体成功率/失败率数字。
6. scores 必须覆盖知识库全部 ${kb.replicabilityDimensions.length} 个维度。
7. improvements 按 priority 排序,target 指向具体镜头,relatedPatternId 填关联的 dimension/weakness id。
8. 全部输出使用中文。

【待评估短剧分镜】
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
