# Replicability rubric v1.1 验证记录

验证日期:2026-07-06。基线 HEAD:`ee563001e801e8741088ff370e302f449b91d8a5`。

## 执行命令与服务重启

旧 3001 进程由管理员停止后,使用新代码启动服务,stdout/stderr 分别重定向到
`rubric-v1.1-server.stdout.log` 与 `rubric-v1.1-server.stderr.log`。启动原文:

```text
◇ injected env (23) from .env // tip: ⌁ auth for agents [www.vestauth.com]
[ShotAnalysis] Module registered: POST /api/shot-analysis/analyze, GET /api/shot-analysis/reports[/:id]
[SQLite] Initializing database and running migration check...
[SQLite Migration] Checking for missing Shot/Character IDs...
[SQLite Migration] All Shot/Character IDs are up to date.
Server is running on http://localhost:3001
[Worker] Starting ComfyUI queue worker...
```

稳定性脚本命令:

```powershell
node scripts/replicability-stability-check.mjs 1> rubric-v1.1-stability.stdout.log 2> rubric-v1.1-stability.stderr.log
```

脚本完成 6 次成功 Gemini 调用并写出 `replicability-stability.json`;因核心稳定性判据
未通过,按设计以 exit code 1 结束。首次启动受管服务时未获网络权限,有一次不计入六次
结果的预检请求在两次即时网络重试后失败;授予网络权限并重启服务后才开始正式两轮。

## 两轮结果与 v1.0 对比

维度缩写:S=stillFrameGenerability,I=identityConsistencyPressure,
C=cameraMotionFeasibility,P=postProductionDependency。

| videoId | v1.0 identity | v1.1 轮1(S/I/C/P) | v1.1 轮2(S/I/C/P) | v1.1 identity | 核心判据 |
| --- | --- | --- | --- | --- | --- |
| 1782541753229 | 5→2 | 8/5/5/5 | 5/5/8/5 | 5→5 | PASS |
| 1783073819790 | 5→2 | 5/5/8/5 | 5/2/8/5 | 5→2 | **FAIL** |
| 1783192167990 | 5→4 | 5/5/10/5 | 5/8/8/5 | 5→8 | **FAIL** |

数值化锚点消除了同一占比的定性解释空间,但没有消除模型逐镜头判定的命中计数漂移。
后两条视频的计数漂移跨越区间,因此核心验收线未通过:

- `1783073819790`:identity 从 `13/61,21.31%` 漂移到 `20/61,32.79%`,分数 5→2。
- `1783192167990`:identity 从 `12/74,16.22%` 漂移到 `3/74,4.05%`,分数 5→8。
- `1782541753229`:identity 从 `15/60,25.0%` 漂移到 `14/60,23.33%`,仍在同一档,分数 5→5。

这是 `multi_character_interaction` 命中计数稳定性问题,不是锚点区间歧义。

## evidence 占比原文

| video/轮次 | stillFrameGenerability | identityConsistencyPressure | cameraMotionFeasibility | postProductionDependency |
| --- | --- | --- | --- | --- |
| 1782541753229/R1 | 60 个镜头中 6 个命中 text_in_frame,占比 10.0% | 60 个镜头中 15 个命中 multi_character_interaction,占比 25.0% | 60 个镜头中 8 个命中 long_tracking_shot,占比 13.33% | 60 个镜头中 7 个命中 graphics_overlay_dependency,占比 11.67% |
| 1782541753229/R2 | 60个镜头中8个命中text_in_frame弱项，占比13.33%。 | 60个镜头中14个命中multi_character_interaction弱项，占比23.33%。 | 60个镜头中6个命中long_tracking_shot弱项，占比10%。 | 60个镜头中8个命中graphics_overlay_dependency弱项，占比13.33%。 |
| 1783073819790/R1 | 61 个镜头中 11 个命中 text_in_frame,占比 18.03% | 61 个镜头中 13 个命中 multi_character_interaction,占比 21.31% | 61 个镜头中 2 个命中运镜弱项,占比 3.27% | 61 个镜头中 8 个命中 graphics_overlay_dependency,占比 13.11% |
| 1783073819790/R2 | 61 个镜头中 10 个命中 text_in_frame,占比 16.39% | 61 个镜头中 20 个命中 multi_character_interaction,占比 32.79% | 61 个镜头中 1 个命中 long_tracking_shot,占比 1.64% | 61 个镜头中 9 个命中 graphics_overlay_dependency,占比 14.75% |
| 1783192167990/R1 | 74 个镜头中 9 个命中 text_in_frame,占比 12.16% | 74 个镜头中 12 个命中 multi_character_interaction,占比 16.22% | 74 个镜头中 0 个命中运镜弱项,占比 0% | 74 个镜头中 8 个命中 graphics_overlay_dependency,占比 10.81% |
| 1783192167990/R2 | 74 个镜头中 8 个命中 text_in_frame,占比 10.81% | 74 个镜头中 3 个命中 multi_character_interaction,占比 4.05% | 74 个镜头中 1 个命中 complex_camera_transition,占比 1.35% | 74 个镜头中 9 个命中 graphics_overlay_dependency,占比 12.16% |

## 脚本输出原文摘录

```json
{"event":"comparison","comparisons":[{"videoId":"1782541753229","scores":{"stillFrameGenerability":"8→5","identityConsistencyPressure":"5→5","cameraMotionFeasibility":"5→8","postProductionDependency":"5→5"},"identityStable":true},{"videoId":"1783073819790","scores":{"stillFrameGenerability":"5→5","identityConsistencyPressure":"5→2","cameraMotionFeasibility":"8→8","postProductionDependency":"5→5"},"identityStable":false},{"videoId":"1783192167990","scores":{"stillFrameGenerability":"5→5","identityConsistencyPressure":"5→8","cameraMotionFeasibility":"10→8","postProductionDependency":"5→5"},"identityStable":false}]}
{"event":"validation","checks":{"identityStableForEveryVideo":false,"all24ScoresAllowed":true,"everyDimensionHasRatioEvidence":true,"allKbVersionsV110":true},"totals":{"promptTokens":55848,"billedOutputTokens":117813,"costUSD":0.311287}}
{"event":"artifact_written","artifact":"replicability-stability.json"}
```

## usage 与成本

计费输出严格按 `totalTokenCount - promptTokenCount` 计算,因此包含 thinking tokens。
输入 $0.30/M,输出 $2.50/M。

| video/轮次 | prompt | candidates | thinking | 计费输出 | 成本(USD) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1782541753229/R1 | 8,735 | 5,991 | 7,384 | 13,375 | 0.036058 |
| 1782541753229/R2 | 8,735 | 6,958 | 10,584 | 17,542 | 0.046475 |
| 1783073819790/R1 | 8,910 | 10,405 | 13,187 | 23,592 | 0.061653 |
| 1783073819790/R2 | 8,910 | 7,080 | 10,202 | 17,282 | 0.045878 |
| 1783192167990/R1 | 10,279 | 13,594 | 14,518 | 28,112 | 0.073364 |
| 1783192167990/R2 | 10,279 | 7,591 | 10,319 | 17,910 | 0.047859 |
| **总计** | **55,848** | — | — | **117,813** | **0.311287** |

## 重试日志原文

正式六次调用中未触发 `GEMINI_INVALID_RESPONSE`;新枚举校验没有产生非法分数重试。
最后一次调用首试超时后按既有机制重试成功:

```text
[ShotAnalysis] {"requestId":"b3dbb631-fd5c-4de8-b48e-b2373bffb7fc","event":"attempt_failed","attempt":1,"code":"GEMINI_TIMEOUT","retryable":true,"attemptDurationMs":120009,"detail":"Gemini request timed out after 120000ms"}
[ShotAnalysis] {"requestId":"b3dbb631-fd5c-4de8-b48e-b2373bffb7fc","event":"attempt_start","attempt":2,"model":"gemini-2.5-flash","analysisType":"replicability","sourceType":"analysis_json","kbVersion":"replicability@1.1.0","timeoutMs":120000}
[ShotAnalysis] {"requestId":"b3dbb631-fd5c-4de8-b48e-b2373bffb7fc","event":"success","attempt":2,"analysisType":"replicability","attemptDurationMs":71559,"totalDurationMs":192070,"overallScore":6.5,"usage":{"promptTokenCount":10279,"candidatesTokenCount":7591,"totalTokenCount":28189}}
```

网络权限授予前的预检失败原文(不计入六次结果,无成功响应、无 usage):

```text
[ShotAnalysis] {"requestId":"eb36a62b-7a0f-4afb-928e-ac2d0b43dd25","event":"attempt_failed","attempt":1,"code":"GEMINI_NETWORK","retryable":true,"attemptDurationMs":61,"detail":"fetch failed"}
[ShotAnalysis] {"requestId":"eb36a62b-7a0f-4afb-928e-ac2d0b43dd25","event":"attempt_failed","attempt":2,"code":"GEMINI_NETWORK","retryable":true,"attemptDurationMs":5,"detail":"fetch failed"}
[ShotAnalysis] {"requestId":"eb36a62b-7a0f-4afb-928e-ac2d0b43dd25","event":"analysis_failed","code":"GEMINI_NETWORK","analysisType":"replicability","sourceRef":"videoId:1782541753229","detail":"fetch failed"}
```

## 验收判据

| 判据 | 结果 | 证据 |
| --- | --- | --- |
| 每个视频两轮 identity 分数完全一致 | **FAIL** | 仅 1782541753229 为 5→5;另两条为 5→2、5→8,原始计数见上表 |
| 24 个分数均属于 `{2,5,8,10}` | PASS | artifact `all24ScoresAllowed:true` |
| 每个维度 evidence 含分子/分母/占比 | PASS | artifact `everyDimensionHasRatioEvidence:true`;24 条原文见上表 |
| kbVersion 为 `replicability@1.1.0` | PASS | 6/6 响应一致;artifact `allKbVersionsV110:true` |
| 计数漂移如实披露 | PASS | identity 三条两轮原始计数与跨档结论见上文 |
| 非法枚举触发类型化错误,不静默放行 | PASS(本轮未触发) | 服务端校验仅接受 2/5/8/10;六次均为合法值,无 `GEMINI_INVALID_RESPONSE` 日志 |

## lint / build 原文

命令:

```powershell
npm run lint
npm run build
```

输出:

```text
> react-example@0.0.0 lint
> tsc --noEmit

> react-example@0.0.0 build
> vite build --configLoader runner

vite v6.4.3 building for production...
transforming...
✓ 2075 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                   0.42 kB │ gzip:   0.29 kB
dist/assets/index-BNXzyuLG.css   91.41 kB │ gzip:  14.36 kB
dist/assets/index-BrsfsZXu.js   552.91 kB │ gzip: 162.46 kB
✓ built in 3.51s

(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
```

lint 与 build 均 exit code 0;chunk size 为既有非阻断 warning。

---

## v1.1.1 措辞修正验证

验证日期:2026-07-06。变更内容:三处措辞/健壮性修正(rubric boundary-rule wording、
prompt 悬空 scoringRule 引用、stability-check 证据正则加固)。

### 修改摘要

1. **replicability-rubric.json** version `1.1.0` → `1.1.1`;scoringRule 步骤 3
   "较低分档(保守)" 改为 "区间边界严格按锚点中的 ≤/< 记号判定(例:占比恰为 25%
   时,落入 '10% < 占比 ≤ 25%' 的 5 分档,而非 2 分档)"。
2. **prompt.ts** `buildReplicabilityPrompt` 规则第 3 条:去除悬空引用 "知识库 scoringRule
   的" → "以下";"边界值归入较低分档" → "区间边界严格按 ≤/< 记号判定"。
3. **replicability-stability-check.mjs** 证据正则:占比正则容忍百分号前空格与全角 ％;
   计数正则容忍 "中有 N 个" 与全角 ／。kbVersion 断言同步更新至 `1.1.1`。

### lint & build

```text
> react-example@0.0.0 lint
> tsc --noEmit
(exit code 0)

> react-example@0.0.0 build
> vite build --configLoader runner
vite v6.4.3 building for production...
✓ 2075 modules transformed.
✓ built in 4.34s
(exit code 0)
```

### 真实调用验证(videoId 1782541753229)

请求:

```text
POST http://localhost:3001/api/shot-analysis/analyze
body: {"videoId":"1782541753229","analysisType":"replicability"}
requestId: 189bc3a5-f9bd-4d56-a4b8-6debe6212191
```

服务端日志确认 `kbVersion: "replicability@1.1.1"`,首次尝试成功(attempt 1)。

响应摘要:

| 维度 | dimensionId | 分数 | 统计证据 | 锚点区间 |
|------|------------|------|---------|---------|
| 静帧可生成性 | stillFrameGenerability | **5** | 60 个镜头中 13 个命中 text_in_frame,占比 21.67% | 10% < 占比 ≤ 30% → 5 |
| 角色一致性压力 | identityConsistencyPressure | **5** | 60 个镜头中 11 个命中 multi_character_interaction,占比 18.33% | 10% < 占比 ≤ 25% → 5 |
| 运镜可行性 | cameraMotionFeasibility | **8** | 60 个镜头中 5 个命中 long_tracking_shot,占比 8.33% | 0% < 占比 ≤ 10% → 8 |
| 后期依赖度 | postProductionDependency | **5** | 60 个镜头中 7 个命中 graphics_overlay_dependency,占比 11.67% | 10% < 占比 ≤ 30% → 5 |

- **overallScore**: 5.75(服务端加权重算)
- **四维度分数均 ∈ {2, 5, 8, 10}**: ✅
- **每个维度 evidence 含分子/分母占比统计**: ✅
- **identity 维度占比 18.33% 落入 "10% < 占比 ≤ 25%" 给 5 分(符合 ≤ 记号)**: ✅
- **无边界精确命中案例**: 本次占比均不在精确边界上,未触发边界判定逻辑

usage / cost:

```json
{
  "promptTokenCount": 8734,
  "candidatesTokenCount": 11476,
  "totalTokenCount": 34573,
  "durationMs": 98400,
  "attempts": 1
}
```
