# 拉片模块验收记录(真实运行,2026-07-06)

验证对象:库内真实短剧《无限恐怖 第二幕・醒来(下)》(videoId `1783192167990`,
74 个分镜,由 `/api/analyze` 此前真实产出)。以下所有输出均为实际命令行/日志原文,非编造。

## 执行命令

```
node scripts/shot-analysis-acceptance.mjs 1783192167990
```

## 验收脚本输出(原文)

```
{"event":"acceptance_start","videoId":"1783192167990","base":"http://localhost:3001","timestamp":"2026-07-06T07:03:56.349Z"}
{"event":"analyze_response","httpStatus":200,"durationMs":50570}
{"event":"report_summary","reportId":"7fe943b4-8ed5-42cf-9229-8d5c4a2b2dd7","kbVersion":"hook@1.0.0+drama@1.0.0+rubric@1.0.0","overallScore":5.75,"hookPatterns":["suspense_question:medium","visual_spectacle:weak"],"reversalCount":3,"scores":{"hookStrength":5,"pacingScore":5,"conflictDensity":5,"emotionCurve":5,"cliffhangerStrength":8,"clarity":8},"improvementCount":4,"diagnostics":{"requestId":"fa7f94fe-72d0-432b-9d7d-4540efe587aa","model":"gemini-2.5-flash","attempts":1,"durationMs":50498}}
{"event":"persistence_verified","reportId":"7fe943b4-8ed5-42cf-9229-8d5c4a2b2dd7","status":"succeeded","kbVersion":"hook@1.0.0+drama@1.0.0+rubric@1.0.0","requestId":"fa7f94fe-72d0-432b-9d7d-4540efe587aa"}
{"event":"acceptance_passed","artifact":"shot-analysis-acceptance.json","totalDurationMs":50576}
```

## 服务端日志(原文,来自运行中的 server.ts 进程)

```
[ShotAnalysis:Migration] Applied 001_create_shot_analysis_reports.sql
[ShotAnalysis] Module registered: POST /api/shot-analysis/analyze, GET /api/shot-analysis/reports[/:id]
[ShotAnalysis] {"requestId":"fa7f94fe-72d0-432b-9d7d-4540efe587aa","event":"attempt_start","attempt":1,"model":"gemini-2.5-flash","sourceType":"analysis_json","kbVersion":"hook@1.0.0+drama@1.0.0+rubric@1.0.0","timeoutMs":120000}
[ShotAnalysis] {"requestId":"fa7f94fe-72d0-432b-9d7d-4540efe587aa","event":"success","attempt":1,"attemptDurationMs":50496,"totalDurationMs":50498,"overallScore":5.75}
```

## 报告内容抽样(完整报告见 shot-analysis-acceptance.json)

钩子命中(带时间戳证据):

```json
{
 "patternId": "suspense_question",
 "strength": "medium",
 "evidence": ["00:13-00:15 标题“无限恐怖 第二幕・醒来(下)”显示在一个昏暗的地下隧道中，火车缓缓驶过。"]
}
```

反转清单与真实剧情吻合(143s 激光网激活 / 242s 规则揭晓 / 312s 电梯尸体),
高优先级改进建议指向具体时间段(00:00-00:20 开场钩子弱,建议闪前前置)。

## 错误路径冒烟(原文)

```
POST /api/shot-analysis/analyze {}                    → HTTP 400 {"error":{"code":"INVALID_INPUT",...}}
POST /api/shot-analysis/analyze {"videoId":"nonexistent"} → HTTP 404 {"error":{"code":"VIDEO_NOT_FOUND",...}}
```

## lint / build(原文)

```
> react-example@0.0.0 lint
> tsc --noEmit

> react-example@0.0.0 build
> vite build --configLoader runner

vite v6.4.3 building for production...
✓ 2075 modules transformed.
dist/index.html                   0.42 kB │ gzip:   0.29 kB
dist/assets/index-BNXzyuLG.css   91.41 kB │ gzip:  14.36 kB
dist/assets/index-BrsfsZXu.js   552.91 kB │ gzip: 162.46 kB
(!) Some chunks are larger than 500 kB after minification. (既有告警,与本模块无关)
✓ built in 4.15s
```

## 约束核对

- workflows/ 01-04 未触碰;
- 新表 `shot_analysis_reports` 由迁移文件 `001_create_shot_analysis_reports.sql` 创建,登记于 `shot_analysis_migrations`,未改动既有表;
- 无静默 fallback:key 缺失/调用失败/schema 不合法均返回类型化错误并以 `status='failed'` 落库留痕;
- 视频文件模式(Files API)已实现,>500MB 明确报错(现有 Gemini 封装无分片能力,如实报告为已知限制)。
