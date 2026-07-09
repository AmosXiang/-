// rubric v1.2 单元测试:服务端确定性预筛、锚点映射边界、裁决校验、主报告 validator 硬化、
// identity 维度服务端合成与 pulid 聚合 advisory。运行:node --test shot-analysis-v12.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countReferents,
  extractAliases,
  hitsToNextBand,
  prescreenMultiCharacterShots,
  ratioToAnchorScore,
} from './server/modules/shot-analysis/prescreen.ts';
import { validateVerdicts } from './server/modules/shot-analysis/adjudicator.ts';
import { synthesizeServerScoredDimension, validateReplicabilityModelReport } from './server/modules/shot-analysis/analyzer.ts';
import { loadKnowledgeBase } from './server/modules/shot-analysis/knowledge.ts';

const kb = loadKnowledgeBase();
const identityDim = kb.replicabilityDimensions.find(d => d.scoredBy === 'server')!;
const LEXICONS = identityDim.prescreen!;

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

test('countReferents:同一角色多次出现只计 1 人;不同角色分开计', () => {
  const aliases = extractAliases([{ name: '陆远' }, { name: '林晓' }]);
  assert.equal(countReferents('陆远用货架抵门,陆远大喊', aliases, []).length, 1);
  assert.equal(countReferents('陆远大喊着让林晓去按开关', aliases, []).length, 2);
});

test('countReferents:紧邻(gap=0)功能词合并为一个人,分隔的注册角色不合并', () => {
  // "黑人""男性""士兵" 紧邻 → 合并为 1 个指称
  const merged = countReferents('一名黑人男性士兵冲进大门', [], LEXICONS.roleFunctionWords);
  assert.equal(merged.length, 1);
  // "郑吒转向詹岚":两个注册角色被"转向"隔开,不得合并(审计确认 gap≤2 会误并)
  const aliases = extractAliases([{ name: '郑吒' }, { name: '詹岚' }]);
  assert.equal(countReferents('郑吒转向詹岚', aliases, []).length, 2);
});

test('prescreen:双指称或复数/互动线索入候选;单人镜头不入', () => {
  const shots = [
    { timestamp: '00:01 - 00:03', description: '陆远与中介经理握手,两人都面带笑容' },
    { timestamp: '00:03 - 00:05', description: '陆远独自走进空荡荡的大厅' },
    { timestamp: '00:05 - 00:08', description: '两人在巷口对峙' },
  ];
  const result = prescreenMultiCharacterShots(shots, [{ name: '陆远' }], LEXICONS);
  assert.equal(result.totalShots, 3);
  assert.deepEqual(result.candidates.map(c => c.shotIndex), [1, 3]);
  assert.ok(result.candidates[0].referents.length >= 2);
  assert.ok(result.candidates[1].cues.length > 0);
});

test('ratioToAnchorScore:区间边界严格按 ≤/< 记号', () => {
  assert.equal(ratioToAnchorScore(0), 10);
  assert.equal(ratioToAnchorScore(0.05), 8);
  assert.equal(ratioToAnchorScore(0.10), 8); // 0 < r ≤ 10% → 8
  assert.equal(ratioToAnchorScore(0.100001), 5);
  assert.equal(ratioToAnchorScore(0.25), 5); // 10% < r ≤ 25% → 5
  assert.equal(ratioToAnchorScore(0.250001), 2);
});

test('hitsToNextBand:边界邻近披露', () => {
  assert.equal(hitsToNextBand(0, 60), 1); // 0 命中,再 1 个即离开 10 分档
  assert.equal(hitsToNextBand(6, 60), 1); // 恰在 10% 边界上,再 1 个跨带
  assert.equal(hitsToNextBand(14, 60), 2); // 23.3%,距 25% 边界还差 2 个
  assert.equal(hitsToNextBand(15, 60), 1); // 恰在 25% 边界上
  assert.equal(hitsToNextBand(16, 60), null); // 已在最低档
  assert.equal(hitsToNextBand(0, 0), null);
});

const CANDIDATES = [
  { shotIndex: 3, timestamp: '00:04 - 00:07', description: 'a', referents: [], cues: [] },
  { shotIndex: 6, timestamp: '00:10 - 00:15', description: 'b', referents: [], cues: [] },
];

test('validateVerdicts:每个候选恰好一次,封闭域,枚举合法', () => {
  const ok = validateVerdicts({ verdicts: [
    { shotIndex: 6, verdict: 'no_hit', reason: '单人画面' },
    { shotIndex: 3, verdict: 'hit', reason: '两人握手' },
  ] }, CANDIDATES);
  assert.deepEqual(ok.map(v => v.shotIndex), [3, 6]); // 输出按 shotIndex 排序

  // 缺一个候选 → 无效
  assert.throws(() => validateVerdicts({ verdicts: [{ shotIndex: 3, verdict: 'hit', reason: 'x' }] }, CANDIDATES),
    (e: any) => e.code === 'GEMINI_INVALID_RESPONSE' && /missing/.test(e.message));
  // 候选外镜头 → 无效
  assert.throws(() => validateVerdicts({ verdicts: [
    { shotIndex: 3, verdict: 'hit', reason: 'x' }, { shotIndex: 6, verdict: 'no_hit', reason: 'x' }, { shotIndex: 9, verdict: 'hit', reason: 'x' },
  ] }, CANDIDATES), (e: any) => /non-candidate/.test(e.message));
  // 重复表态 → 无效
  assert.throws(() => validateVerdicts({ verdicts: [
    { shotIndex: 3, verdict: 'hit', reason: 'x' }, { shotIndex: 3, verdict: 'no_hit', reason: 'x' }, { shotIndex: 6, verdict: 'no_hit', reason: 'x' },
  ] }, CANDIDATES), (e: any) => /Duplicate/.test(e.message));
  // 非法 verdict → 无效
  assert.throws(() => validateVerdicts({ verdicts: [
    { shotIndex: 3, verdict: 'maybe', reason: 'x' }, { shotIndex: 6, verdict: 'no_hit', reason: 'x' },
  ] }, CANDIDATES), (e: any) => /Invalid verdict/.test(e.message));
});

function modelReport(overrides: any = {}) {
  return {
    shotRisks: [],
    scores: [
      { dimensionId: 'stillFrameGenerability', score: 8, evidence: ['60 个镜头中 4 个命中 text_in_frame,占比 6.7%'], reasoning: 'r' },
      { dimensionId: 'cameraMotionFeasibility', score: 5, evidence: ['60 个镜头中 8 个命中运镜弱项,占比 13.3%'], reasoning: 'r' },
      { dimensionId: 'postProductionDependency', score: 10, evidence: ['60 个镜头中 0 个命中后期依赖,占比 0%'], reasoning: 'r' },
    ],
    overallScore: 0,
    improvements: [],
    summary: 's',
    ...overrides,
  };
}

test('主报告 validator:模型发射服务端弱项/维度分数判无效;shotRef 强制镜头前缀', () => {
  assert.ok(validateReplicabilityModelReport(modelReport(), kb));

  // 发射 multi_character_interaction → 无效
  assert.throws(() => validateReplicabilityModelReport(modelReport({ shotRisks: [
    { shotRef: '镜头3 00:04-00:07', dimensionId: 'identityConsistencyPressure', weaknessId: 'multi_character_interaction', severity: 'high', evidence: ['x'], recommendation: 'x' },
  ] }), kb), (e: any) => /server-computed weakness/.test(e.message));
  // 发射 pulid_latency → 无效
  assert.throws(() => validateReplicabilityModelReport(modelReport({ shotRisks: [
    { shotRef: '镜头3 00:04-00:07', dimensionId: 'identityConsistencyPressure', weaknessId: 'pulid_latency', severity: 'medium', evidence: ['x'], recommendation: 'x' },
  ] }), kb), (e: any) => /server-computed weakness/.test(e.message));
  // 为 identity 维度输出分数 → 无效
  const withIdentityScore = modelReport();
  withIdentityScore.scores.push({ dimensionId: 'identityConsistencyPressure', score: 5, evidence: ['x'], reasoning: 'r' });
  assert.throws(() => validateReplicabilityModelReport(withIdentityScore, kb), (e: any) => /server-computed or unknown dimension/.test(e.message));
  // shotRef 纯时间戳(历史 12 轮出现过 1 次)→ 无效
  assert.throws(() => validateReplicabilityModelReport(modelReport({ shotRisks: [
    { shotRef: '00:04-00:07', dimensionId: 'stillFrameGenerability', weaknessId: 'text_in_frame', severity: 'high', evidence: ['x'], recommendation: 'x' },
  ] }), kb), (e: any) => /shotRef must start with/.test(e.message));
  // 模型侧维度缺一 → 无效
  const missing = modelReport();
  missing.scores.pop();
  assert.throws(() => validateReplicabilityModelReport(missing, kb), (e: any) => /not scored/.test(e.message));
});

test('服务端合成:identity 维度分/证据/shotRisks/总分与 pulid 聚合 advisory', () => {
  // 20 个镜头:12 个含注册角色(占比 60%,不超阈值);候选 4 个,裁决 3 hit → 占比 15% → 5 分。
  const shots = Array.from({ length: 20 }, (_, i) => ({
    timestamp: `00:${String(i).padStart(2, '0')}`,
    timeSeconds: i,
    movement: '', composition: '', emotion: '',
    description: i < 12 ? `陆远在第${i}个镜头里` : `空镜头${i}`,
  }));
  const input = { title: 't', shots, characters: [{ name: '陆远', role: '主角' }] } as any;
  const prescreen = { totalShots: 20, aliases: ['陆远'], candidates: [
    { shotIndex: 1, timestamp: '00:00', description: 'd1', referents: [], cues: [] },
    { shotIndex: 2, timestamp: '00:01', description: 'd2', referents: [], cues: [] },
    { shotIndex: 3, timestamp: '00:02', description: 'd3', referents: [], cues: [] },
    { shotIndex: 4, timestamp: '00:03', description: 'd4', referents: [], cues: [] },
  ] };
  const verdicts = [
    { shotIndex: 1, verdict: 'hit', reason: 'r1' },
    { shotIndex: 2, verdict: 'hit', reason: 'r2' },
    { shotIndex: 3, verdict: 'hit', reason: 'r3' },
    { shotIndex: 4, verdict: 'no_hit', reason: 'r4' },
  ] as const;
  const report = modelReport();
  synthesizeServerScoredDimension(report, kb, identityDim, prescreen as any, [...verdicts] as any, input);

  const identityScore = report.scores.find((s: any) => s.dimensionId === 'identityConsistencyPressure');
  assert.equal(identityScore.score, 5); // 3/20 = 15% → 5 分档
  assert.match(identityScore.evidence[0], /20 个镜头中 3 个命中 multi_character_interaction,占比 15\.0%/);
  // 合成的 shotRisks:3 条 hit,镜头前缀 + 裁决依据
  const risks = report.shotRisks.filter((r: any) => r.weaknessId === 'multi_character_interaction');
  assert.equal(risks.length, 3);
  assert.match(risks[0].shotRef, /^镜头1 /);
  assert.match(risks[0].evidence[1], /裁决依据:r1/);
  // 60% 不超过阈值(> 0.6 才触发)→ 无 advisory
  assert.equal(report.aggregateAdvisories, undefined);
  // serverComputed 过程数据完整
  const sc = (report as any).serverComputed.identityConsistencyPressure;
  assert.equal(sc.candidateCount, 4);
  assert.equal(sc.hitCount, 3);
  assert.deepEqual(sc.hitShotIndexes, [1, 2, 3]);
  assert.equal(sc.hitsToNextBand, 3); // 15% → 距 25% 边界:floor(0.25*20)+1-3 = 3
  // 总分服务端重算:0.35*8 + 0.25*5 + 0.25*5 + 0.15*10 = 6.8
  assert.equal(report.overallScore, 6.8);
});

test('pulid 聚合 advisory:身份锁定占比 >60% 时输出,含分子分母与阈值', () => {
  const shots = Array.from({ length: 20 }, (_, i) => ({
    timestamp: `00:${String(i).padStart(2, '0')}`,
    timeSeconds: i,
    movement: '', composition: '', emotion: '',
    description: i < 13 ? `陆远在第${i}个镜头里` : `空镜头${i}`,
  }));
  const input = { title: 't', shots, characters: [{ name: '陆远', role: '主角' }] } as any;
  const prescreen = { totalShots: 20, aliases: ['陆远'], candidates: [] };
  const report = modelReport();
  synthesizeServerScoredDimension(report, kb, identityDim, prescreen as any, [], input);

  const identityScore = report.scores.find((s: any) => s.dimensionId === 'identityConsistencyPressure');
  assert.equal(identityScore.score, 10); // 0 命中 → 10 分
  assert.equal(report.aggregateAdvisories.length, 1); // 13/20 = 65% > 60%
  const advisory = report.aggregateAdvisories[0];
  assert.equal(advisory.weaknessId, 'pulid_latency');
  assert.equal(advisory.numerator, 13);
  assert.equal(advisory.denominator, 20);
  assert.match(advisory.message, /65\.0% 超过阈值 60%/);
  // advisory 不进 shotRisks
  assert.equal(report.shotRisks.filter((r: any) => r.weaknessId === 'pulid_latency').length, 0);
});
