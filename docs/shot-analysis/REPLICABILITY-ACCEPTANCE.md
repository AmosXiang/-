# 可生产性(replicability)分析验收记录(真实运行,2026-07-06)

对库内全部 3 条真实短剧视频各执行 replicability 分析。共两轮真实运行
(第一轮成本公式有误,第二轮修正后重跑,顺带获得复现性对照数据)。
以下均为命令行输出原文。

## 执行命令

```
node scripts/replicability-acceptance.mjs 1782541753229 1783073819790 1783192167990
```

## 第二轮输出(成本公式修正后,原文摘录)

```
{"event":"run_summary","videoId":"1782541753229","reportId":"27a2ab6e-df02-4589-a117-508e0134624d","analysisType":"replicability","kbVersion":"replicability@1.0.0","overallScore":5.5,"scores":{"stillFrameGenerability":5,"identityConsistencyPressure":2,"cameraMotionFeasibility":10,"postProductionDependency":5},"shotRiskCount":42,"riskBreakdown":{"multi_character_interaction":20,"text_in_frame":15,"graphics_overlay_dependency":7},"usage":{"promptTokenCount":8606,"candidatesTokenCount":6793,"totalTokenCount":35690,"thoughtsTokens":20291,"billedOutputTokens":27084},"costUSD":{"input":0.0026,"output":0.0677,"total":0.0703},"durationMs":108001}
{"event":"run_summary","videoId":"1783073819790","reportId":"90cb4c24-39d6-4270-8797-b8a31025abe5",...,"overallScore":5,"scores":{"stillFrameGenerability":5,"identityConsistencyPressure":2,"cameraMotionFeasibility":8,"postProductionDependency":5},"shotRiskCount":47,...,"usage":{"promptTokenCount":8781,"candidatesTokenCount":7556,"totalTokenCount":30964,"thoughtsTokens":14627,"billedOutputTokens":22183},"costUSD":{"input":0.0026,"output":0.0555,"total":0.0581},"durationMs":86673}
{"event":"run_summary","videoId":"1783192167990","reportId":"467cc610-2519-418f-bd99-2d22af6ea308",...,"overallScore":6.2,"scores":{"stillFrameGenerability":7,"identityConsistencyPressure":4,"cameraMotionFeasibility":8,"postProductionDependency":5},"shotRiskCount":50,...,"usage":{"promptTokenCount":10150,"candidatesTokenCount":8055,"totalTokenCount":34979,"thoughtsTokens":16774,"billedOutputTokens":24829},"costUSD":{"input":0.003,"output":0.0621,"total":0.0651},"durationMs":97928}
{"event":"persistence_filter_verified","listedReplicabilityReports":6}
{"event":"acceptance_passed","runs":3,"perEpisodeCostsUSD":[0.0703,0.0581,0.0651],"totalCostUSD":0.1935,"estimateRangeUSD":[0.02,0.05],"allWithinEstimate":false}
```

## 成本核对(如实结论:估算被超出)

| 视频 | 输入 token | 计费输出 token(含 thinking) | 实际成本 |
| --- | --- | --- | --- |
| 1782541753229(60 镜头) | 8,606 | 27,084(其中 thinking 20,291) | **$0.0703** |
| 1783073819790(61 镜头) | 8,781 | 22,183(其中 thinking 14,627) | **$0.0581** |
| 1783192167990(74 镜头) | 10,150 | 24,829(其中 thinking 16,774) | **$0.0651** |

**结论:实际 $0.058-0.070/集,超出评估文档承诺的 $0.02-0.05 区间(约 1.3-1.4 倍)。**

误差根因(承认估算错误):评估阶段的估算只计了输入+可见输出,
**漏算了 gemini-2.5-flash 的 thinking tokens**——实测每次 1.5-2 万,按输出价
($2.50/M)计费,是单集成本的最大头(约 75%)。第一轮验收脚本的成本公式犯了
同样的错(只算 candidatesTokenCount,得出 $0.018-0.029 的虚低数字),
第二轮已修正为 `billedOutput = totalTokenCount - promptTokenCount`。

量级判断不受影响:与反面参考($25/30 分钟)相比仍低约 350 倍以上。
**可用的降本杠杆(未实施,留待决策)**:`thinkingConfig.thinkingBudget` 可限制或
关闭思考,预计能把单集成本压回 ~$0.02,但可能影响逐镜头风险识别质量,
需要对照实验后再定,不做静默变更。

## 复现性对照(两轮独立运行,temperature 0.1)

| 视频 | 总分(轮1→轮2) | 波动最大的维度 |
| --- | --- | --- |
| 1782541753229 | 5.75 → 5.5 | identityConsistencyPressure 5→2;cameraMotionFeasibility 8→10 |
| 1783073819790 | 5.0 → 5.0 | identityConsistencyPressure 5→2;cameraMotionFeasibility 5→8 |
| 1783192167990 | 6.8 → 6.2 | identityConsistencyPressure 5→4 |

定性结论稳定:两轮的 riskBreakdown 均以 multi_character_interaction 与
text_in_frame 为主导,风险清单方向一致;总分波动 ≤0.6。
**但 identityConsistencyPressure 单维度出现 5→2 的跨锚点波动**——该维度锚点
是定性描述("高频""零星"),对"20/74 镜头多人同框"这类中间地带,模型两次
落在了不同锚点。已知缓解方向(留待 rubric v1.1,不在本次范围):把锚点改为
数值化阈值(如"多人同框镜头占比 >25% → ≤3 分"),消除解释空间。

## 落库与过滤校验

`GET /api/shot-analysis/reports?analysisType=replicability` 返回 6 条
(两轮 × 3 集),本轮 3 条 reportId 均在列;历史 narrative 报告不受影响
(analysisType 回填验证见 commit B 冒烟记录)。

## lint / build(原文)

```
> react-example@0.0.0 lint
> tsc --noEmit

> react-example@0.0.0 build
> vite build --configLoader runner
✓ 2075 modules transformed.
✓ built in 3.50s
```

## 约束核对

- workflows/ 01-04 未触碰;
- analysisType 列走迁移文件 002,历史行回填 narrative(实测验证);
- 无静默 fallback:非法 analysisType → 400;replicability+video 输入 → 422;
  Gemini 失败 → 类型化错误 + status='failed' 落库;
- 报告中运镜维度无任何虚构的成功率/失败率数字(rubric 规则第 5 条强制)。
