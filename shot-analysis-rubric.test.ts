// rubric v1.2/v1.3 单元测试:服务端确定性预筛(人物指称 + 通用词表)、参数化锚点映射、
// (镜头, 弱项) 对裁决校验、叙述输出校验、四维度服务端合成与 pulid 聚合 advisory。
// 运行:node --test shot-analysis-rubric.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countReferents,
  extractAliases,
  hitsToNextBand,
  prescreenLexiconShots,
  prescreenMultiCharacterShots,
  ratioToAnchorScore,
  type PrescreenResult,
} from './server/modules/shot-analysis/prescreen.ts';
import { validateVerdicts, type AdjudicationPair, type AdjudicationVerdict } from './server/modules/shot-analysis/adjudicator.ts';
import { synthesizeServerScoredDimensions, validateReplicabilityNarrative } from './server/modules/shot-analysis/analyzer.ts';
import { loadKnowledgeBase } from './server/modules/shot-analysis/knowledge.ts';

const kb = loadKnowledgeBase();
const dimById = new Map(kb.replicabilityDimensions.map(d => [d.id, d]));
const identityDim = dimById.get('identityConsistencyPressure')!;
const IDENTITY_LEXICONS = {
  roleFunctionWords: identityDim.prescreen!.roleFunctionWords!,
  pluralInteractionCues: identityDim.prescreen!.pluralInteractionCues!,
};
const T25 = { t8: 0.10, t5: 0.25 };
const T30 = { t8: 0.10, t5: 0.30 };

test('知识库 v1.3.0:四个维度全部 scoredBy: server,各带词表/few-shot/anchorThresholds', () => {
  assert.equal(kb.replicabilityVersion, 'replicability@1.3.1');
  assert.equal(kb.replicabilityDimensions.length, 4);
  for (const d of kb.replicabilityDimensions) {
    assert.equal(d.scoredBy, 'server', `${d.id} 应为 server-scored`);
    assert.ok(d.prescreen, `${d.id} 缺 prescreen`);
    assert.ok(d.adjudicationFewShots!.length >= 2, `${d.id} few-shot 不足`);
    assert.ok(d.anchorThresholds!.t8 > 0 && d.anchorThresholds!.t5 > d.anchorThresholds!.t8);
  }
});

test('extractAliases:斜杠拆分、括号拆分、短碎片过滤、按角色共享 key', () => {
  const aliases = extractAliases([
    { name: '路人甲 / 胖子' },
    { name: '马修艾迪生 (Matthew Addison)' },
    { name: '梅 (Mei)' },
  ]);
  const byAlias = Object.fromEntries(aliases.map(a => [a.alias, a.characterKey]));
  assert.equal(byAlias['路人甲'], 'char:0');
  assert.equal(byAlias['胖子'], 'char:0'); // 同一角色的两个别名共享 key
  assert.equal(byAlias['马修艾迪生'], 'char:1');
  assert.equal(byAlias['Matthew Addison'], 'char:1');
  assert.equal(byAlias['Mei'], 'char:2');
  assert.equal(byAlias['梅'], undefined); // 长度 <2 的碎片丢弃
});

test('countReferents:同角色去重、gap=0 合并、分隔角色不合并', () => {
  const aliases = extractAliases([{ name: '陆远' }, { name: '林晓' }]);
  assert.equal(countReferents('陆远用货架抵门,陆远大喊', aliases, []).length, 1);
  assert.equal(countReferents('陆远大喊着让林晓去按开关', aliases, []).length, 2);
  assert.equal(countReferents('一名黑人男性士兵冲进大门', [], IDENTITY_LEXICONS.roleFunctionWords).length, 1);
  const zj = extractAliases([{ name: '郑吒' }, { name: '詹岚' }]);
  assert.equal(countReferents('郑吒转向詹岚', zj, []).length, 2);
});

test('identity 预筛:双指称或复数/互动线索入候选;单人镜头不入', () => {
  const shots = [
    { timestamp: '00:01 - 00:03', description: '陆远与中介经理握手,两人都面带笑容' },
    { timestamp: '00:03 - 00:05', description: '陆远独自走进空荡荡的大厅' },
    { timestamp: '00:05 - 00:08', description: '两人在巷口对峙' },
  ];
  const result = prescreenMultiCharacterShots(shots, [{ name: '陆远' }], IDENTITY_LEXICONS);
  assert.deepEqual(result.candidates.map(c => c.shotIndex), [1, 3]);
});

test('通用词表预筛:字段选择、词命中、movement 多段规则', () => {
  const shots = [
    { timestamp: '00:00', movement: '固定镜头', description: '手机屏幕上弹出银行到账信息' },
    { timestamp: '00:02', movement: '特写镜头, 广角镜头', description: '激光网切割走廊' },
    { timestamp: '00:04', movement: '平移镜头', description: '空荡荡的走廊尽头' },
    { timestamp: '00:06', movement: '跟踪镜头', description: '士兵穿过大门' },
  ];
  const textDim = dimById.get('stillFrameGenerability')!;
  const text = prescreenLexiconShots(shots, textDim.prescreen!);
  assert.deepEqual(text.candidates.map(c => c.shotIndex), [1]); // 屏幕/手机/弹出命中

  const camDim = dimById.get('cameraMotionFeasibility')!;
  const cam = prescreenLexiconShots(shots, camDim.prescreen!);
  // shot2 走 movement 多段规则,shot4 走"跟踪"词命中;shot3 平移不入候选
  assert.deepEqual(cam.candidates.map(c => c.shotIndex), [2, 4]);
  assert.ok(cam.candidates[0].cues.includes('<多段运镜>'));
});

test('ratioToAnchorScore:阈值参数化,边界严格按 ≤/<', () => {
  assert.equal(ratioToAnchorScore(0, T25), 10);
  assert.equal(ratioToAnchorScore(0.10, T25), 8);
  assert.equal(ratioToAnchorScore(0.100001, T25), 5);
  assert.equal(ratioToAnchorScore(0.25, T25), 5);
  assert.equal(ratioToAnchorScore(0.250001, T25), 2);
  assert.equal(ratioToAnchorScore(0.28, T30), 5); // still/post 用 30% 阈值
  assert.equal(ratioToAnchorScore(0.30, T30), 5);
  assert.equal(ratioToAnchorScore(0.300001, T30), 2);
});

test('hitsToNextBand:阈值参数化的边界邻近披露', () => {
  assert.equal(hitsToNextBand(0, 60, T25), 1);
  assert.equal(hitsToNextBand(6, 60, T25), 1); // 恰在 10% 边界
  assert.equal(hitsToNextBand(14, 60, T25), 2); // 23.3% 距 25% 差 2 个
  assert.equal(hitsToNextBand(16, 60, T25), null); // 已在最低档
  assert.equal(hitsToNextBand(17, 60, T30), 2); // 28.3%,30% 阈值下距边界 2 个
  assert.equal(hitsToNextBand(0, 0, T25), null);
});

const PAIRS: AdjudicationPair[] = [
  { shotIndex: 3, weaknessId: 'text_in_frame', timestamp: '00:04', description: 'a' },
  { shotIndex: 5, weaknessId: 'long_tracking_shot', timestamp: '00:08', description: 'b' },
  { shotIndex: 5, weaknessId: 'complex_camera_transition', timestamp: '00:08', description: 'b' },
];

test('validateVerdicts:(镜头, 弱项) 对封闭域,每对恰好一次', () => {
  const ok = validateVerdicts({ verdicts: [
    { shotIndex: 5, weaknessId: 'complex_camera_transition', verdict: 'no_hit', reason: 'x' },
    { shotIndex: 3, weaknessId: 'text_in_frame', verdict: 'hit', reason: 'x' },
    { shotIndex: 5, weaknessId: 'long_tracking_shot', verdict: 'hit', reason: 'x' },
  ] }, PAIRS);
  assert.equal(ok.length, 3);
  assert.deepEqual(ok.map(v => v.shotIndex), [3, 5, 5]); // 按 shotIndex+weaknessId 排序

  // 缺一对 → 无效
  assert.throws(() => validateVerdicts({ verdicts: [
    { shotIndex: 3, weaknessId: 'text_in_frame', verdict: 'hit', reason: 'x' },
    { shotIndex: 5, weaknessId: 'long_tracking_shot', verdict: 'hit', reason: 'x' },
  ] }, PAIRS), (e: any) => e.code === 'GEMINI_INVALID_RESPONSE' && /missing/.test(e.message));
  // 候选外弱项 → 无效(同镜头也不行)
  assert.throws(() => validateVerdicts({ verdicts: [
    { shotIndex: 3, weaknessId: 'graphics_overlay_dependency', verdict: 'hit', reason: 'x' },
    { shotIndex: 3, weaknessId: 'text_in_frame', verdict: 'hit', reason: 'x' },
    { shotIndex: 5, weaknessId: 'long_tracking_shot', verdict: 'hit', reason: 'x' },
    { shotIndex: 5, weaknessId: 'complex_camera_transition', verdict: 'no_hit', reason: 'x' },
  ] }, PAIRS), (e: any) => /non-candidate/.test(e.message));
  // 重复表态 → 无效
  assert.throws(() => validateVerdicts({ verdicts: [
    { shotIndex: 3, weaknessId: 'text_in_frame', verdict: 'hit', reason: 'x' },
    { shotIndex: 3, weaknessId: 'text_in_frame', verdict: 'no_hit', reason: 'x' },
    { shotIndex: 5, weaknessId: 'long_tracking_shot', verdict: 'hit', reason: 'x' },
    { shotIndex: 5, weaknessId: 'complex_camera_transition', verdict: 'no_hit', reason: 'x' },
  ] }, PAIRS), (e: any) => /Duplicate/.test(e.message));
  // 非法 verdict → 无效
  assert.throws(() => validateVerdicts({ verdicts: [
    { shotIndex: 3, weaknessId: 'text_in_frame', verdict: 'maybe', reason: 'x' },
    { shotIndex: 5, weaknessId: 'long_tracking_shot', verdict: 'hit', reason: 'x' },
    { shotIndex: 5, weaknessId: 'complex_camera_transition', verdict: 'no_hit', reason: 'x' },
  ] }, PAIRS), (e: any) => /Invalid verdict/.test(e.message));
});

test('叙述输出校验:priority/target 前缀/relatedPatternId 封闭域/成功率数字禁令', () => {
  const good = {
    improvements: [{ priority: 'high', target: '镜头5 00:08-00:16', issue: 'i', suggestion: 's', relatedPatternId: 'long_tracking_shot' }],
    summary: '整体可生产性中等,最大风险是长跟踪镜头。',
  };
  const parsed = validateReplicabilityNarrative(good, kb);
  assert.equal(parsed.improvements.length, 1);
  // 全剧/整体级建议放行
  assert.ok(validateReplicabilityNarrative({ ...good, improvements: [{ ...good.improvements[0], target: '全剧多角色镜头' }] }, kb));
  assert.ok(validateReplicabilityNarrative({ ...good, improvements: [{ ...good.improvements[0], target: '整体节奏' }] }, kb));

  assert.throws(() => validateReplicabilityNarrative({ ...good, improvements: [{ ...good.improvements[0], priority: 'urgent' }] }, kb), /priority/);
  assert.throws(() => validateReplicabilityNarrative({ ...good, improvements: [{ ...good.improvements[0], target: '00:08-00:16' }] }, kb), /target must start with/);
  assert.throws(() => validateReplicabilityNarrative({ ...good, improvements: [{ ...good.improvements[0], relatedPatternId: 'made_up' }] }, kb), /relatedPatternId/);
  assert.throws(() => validateReplicabilityNarrative({ improvements: [], summary: '  ' }, kb), /empty summary/);
  // 运镜维度 unverified:任何成功率/失败率数字判无效
  assert.throws(() => validateReplicabilityNarrative({ improvements: [], summary: '长跟踪镜头成功率约 40%,建议拆分。' }, kb), /success\/failure-rate/);
});

test('四维度服务端合成:占比去重、双弱项 shotRisks、pulid advisory、加权总分', () => {
  // 20 个镜头:前 13 个含注册角色陆远(65% > 60% → pulid advisory)。
  const shots = Array.from({ length: 20 }, (_, i) => ({
    timestamp: `00:${String(i).padStart(2, '0')}`,
    timeSeconds: i,
    movement: '固定镜头', composition: '', emotion: '',
    description: i < 13 ? `陆远在第${i}个镜头里` : `空镜头${i}`,
  }));
  const input = { title: 't', shots, characters: [{ name: '陆远', role: '主角' }] } as any;

  const mkPrescreen = (indexes: number[]): PrescreenResult => ({
    totalShots: 20,
    aliases: [],
    candidates: indexes.map(i => ({ shotIndex: i, timestamp: shots[i - 1].timestamp, description: shots[i - 1].description, referents: [], cues: [] })),
  });
  const perDim = [
    { dim: dimById.get('stillFrameGenerability')!, prescreen: mkPrescreen([1, 2]) },
    { dim: identityDim, prescreen: mkPrescreen([3, 4]) },
    { dim: dimById.get('cameraMotionFeasibility')!, prescreen: mkPrescreen([5, 6]) },
    { dim: dimById.get('postProductionDependency')!, prescreen: mkPrescreen([7, 8, 9, 10, 11, 12, 13]) },
  ];
  const verdicts: AdjudicationVerdict[] = [
    { shotIndex: 1, weaknessId: 'text_in_frame', verdict: 'hit', reason: 'r' },
    { shotIndex: 2, weaknessId: 'text_in_frame', verdict: 'no_hit', reason: 'r' },
    { shotIndex: 3, weaknessId: 'multi_character_interaction', verdict: 'hit', reason: 'r' },
    { shotIndex: 4, weaknessId: 'multi_character_interaction', verdict: 'hit', reason: 'r' },
    // 镜头5 同时命中两个运镜弱项:占比只计一次,shotRisks 出两条
    { shotIndex: 5, weaknessId: 'long_tracking_shot', verdict: 'hit', reason: 'r' },
    { shotIndex: 5, weaknessId: 'complex_camera_transition', verdict: 'hit', reason: 'r' },
    { shotIndex: 6, weaknessId: 'long_tracking_shot', verdict: 'no_hit', reason: 'r' },
    { shotIndex: 6, weaknessId: 'complex_camera_transition', verdict: 'no_hit', reason: 'r' },
    ...([7, 8, 9, 10, 11, 12, 13] as const).map(i => ({ shotIndex: i, weaknessId: 'graphics_overlay_dependency', verdict: 'hit' as const, reason: 'r' })),
  ];

  const s = synthesizeServerScoredDimensions(kb, input, perDim, verdicts);
  const scoreOf = (id: string) => s.scores.find(x => x.dimensionId === id)!.score;
  assert.equal(scoreOf('stillFrameGenerability'), 8); // 1/20 = 5%
  assert.equal(scoreOf('identityConsistencyPressure'), 8); // 2/20 = 10% ≤ t8
  assert.equal(scoreOf('cameraMotionFeasibility'), 8); // 去重后 1/20 = 5%
  assert.equal(scoreOf('postProductionDependency'), 2); // 7/20 = 35% > 30%
  // 总分:0.35*8 + 0.25*8 + 0.25*8 + 0.15*2 = 7.1
  assert.equal(s.overallScore, 7.1);
  // 镜头5 两条 shotRisks(两个弱项),severity 分别取各弱项 riskLevel
  const shot5Risks = s.shotRisks.filter(r => r.shotRef.startsWith('镜头5 '));
  assert.equal(shot5Risks.length, 2);
  assert.deepEqual(shot5Risks.map(r => r.severity).sort(), ['high', 'medium']);
  // serverComputed 覆盖四维度,camera 去重计数
  assert.equal(Object.keys(s.serverComputed).length, 4);
  assert.equal(s.serverComputed.cameraMotionFeasibility.hitCount, 1);
  assert.deepEqual(s.serverComputed.cameraMotionFeasibility.hitShotIndexes, [5]);
  assert.equal(s.serverComputed.postProductionDependency.hitsToNextBand, null);
  // pulid advisory:13/20 = 65% > 60%
  assert.equal(s.aggregateAdvisories.length, 1);
  assert.equal(s.aggregateAdvisories[0].numerator, 13);
  // serverStats 供叙述调用,四条
  assert.equal(s.serverStats.length, 4);
});
