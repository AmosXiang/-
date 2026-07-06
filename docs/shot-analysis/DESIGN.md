# 拉片(Shot Analysis)知识库驱动分析模块 — 设计说明

## 参考项目溯源(如实说明)

任务给出的参考是一条抖音视频链接(YAN:《用 Claude Code 拉片并教你复刻任何视频》,
video id 7649743055003585827)。该链接经跳转后是 JS 渲染的视频播放页,服务端抓取内容为空;
多轮检索(GitHub / 中文技术社区)均未找到该作者公开的、包含 hookPatterns / dramaPatterns /
scoringRubric 的源码仓库。**因此本设计没有阅读到参考项目源码**,以下三个概念取自任务描述,
数据结构与判定标准为本项目针对中文竖屏短剧场景的原创设计:

- `hookPatterns` → `knowledge/hook-patterns.json`(8 种开场钩子模式)
- `dramaPatterns` → `knowledge/drama-patterns.json`(6 种结构/节奏模式)
- `scoringRubric` → `knowledge/scoring-rubric.json`(6 个锚定评分维度)

与「通用视频拉片」相比,中文短剧场景的关键差异及对应取舍:

| 差异点 | 通用拉片假设 | 本设计的短剧取舍 |
| --- | --- | --- |
| 时长 | 分钟~小时级 | 单集 60-180 秒,所有指标按秒级窗口定义 |
| 钩子窗口 | 前 1-2 分钟 | 前 3-15 秒,划走成本趋近于零 |
| 叙事母题 | 类型片语法 | 爽点文化:打脸/逆袭/身份反差/卡点是一等公民 |
| 节奏基准 | 横屏电影 3-8 秒/镜头 | 竖屏 2-5 秒,冲突段 1-3 秒 |
| 语言 | 英文术语体系 | 全中文信号词与锚点,匹配国产短剧台词特征 |

## 可复现性设计(能被 Gemini 稳定调用)

评分不可复现的根源是「让模型凭感觉打分」。本设计的对策:

1. **锚定量表(anchored rubric)**:每个维度在 2/5/8/10 四个刻度给出行为化描述,
   模型是在做「对照锚点归类」,不是自由打分。
2. **证据先行**:schema 强制每个分数携带 `evidence[]`(具体时间戳/镜头引用),
   prompt 中规定「先引证据再给分」,无证据的维度视为无效输出。
3. **结构化输出**:复用 server.ts 既有的 `responseMimeType: 'application/json'` +
   `responseSchema` 模式,杜绝自由文本解析。
4. **低温采样**:`temperature: 0.1`(与 server.ts 中 `optimizeStoryboardPrompt` 一致)。
5. **知识库版本化**:三个 JSON 均带 `version`,报告落库时记录 `kbVersion`,
   跨版本的分数不做直接比较。
6. **封闭 id 域**:`patternId` / `dimensionId` 必须取自知识库枚举,服务端校验,
   未知 id 直接判为 `GEMINI_INVALID_RESPONSE`(不静默丢弃)。

## 与现有 Gemini 封装的复用关系

复用 server.ts 已验证的模式(未重新发明):

- 客户端构造:按调用 `new GoogleGenAI({ apiKey })`,模型 `gemini-2.5-flash`;
- 视频输入:Files API 上传 → 轮询 `PROCESSING` → `generateContent` 携带 `fileData` → 完成后 `files.delete` 清理(同 `/api/analyze`);
- 错误分类:超时/鉴权/限流/网络/无效响应 的类型化分类,429 可重试、鉴权不可重试(同 `classifyGeminiImageError`);
- 超时与重试:`withGeminiTimeout` + maxAttempts=2 + `500*attempt` 退避(同 `/api/analyze-image-prompt`);
- 日志:带 `requestId` 的结构化 JSON 日志,HTTP 响应携带 diagnostics。

**实现说明**:server.ts 是 6800+ 行的入口脚本,不导出任何符号(import 即启动服务),
无法直接 import 复用。上述通用逻辑被逐字提取到 `server/lib/gemini.ts` 供本模块使用;
server.ts 内部的原始副本保持不动 —— 让既有端点改为 import 共享库属于独立的重构关注点,
且 server.ts 当前存在大量未提交的无关改动,牵连提交会破坏 commit 边界。该重构留作后续任务。

**已知限制(如实报告)**:现有封装(Files API 单文件上传)不支持长视频分片。
对单集 1-3 分钟的短剧无影响;模块对超大文件(>500MB)返回明确错误而非静默降级。

## 输入与输出

两种输入模式:

1. `videoId`:复用 `/api/analyze` 已产出的结构化分镜 JSON(store.videos 中的
   shots/characters/narrative),不重复上传视频。快、省配额,是默认路径。
2. `filename + filepath`:直接分析视频文件(Files API),适用于尚未入库的素材。

输出为 `ShotAnalysisReport`(见 `schema.ts`):钩子命中(含强度锚定)、结构模式符合度、
反转清单、逐维度带证据评分、加权总分、按优先级排序的可改进点。

## 持久化

新表 `shot_analysis_reports`(迁移文件 `migrations/001_create_shot_analysis_reports.sql`,
由模块内迁移执行器按序应用并登记于 `shot_analysis_migrations`)。不改动任何既有表。
写入使用 better-sqlite3 同步 `prepare().run()`,与 `comfyui_tasks` 的写法一致
(单进程 + 同步驱动,无新增并发写风险)。

## 失败语义(无静默 fallback)

- `GEMINI_API_KEY` 未配置 → HTTP 500 + `GEMINI_NOT_CONFIGURED`,不产出报告;
- Gemini 调用失败(含重试耗尽)→ HTTP 4xx/5xx + 类型化错误码,
  失败记录以 `status='failed'` 落库留痕;
- 模型返回未知 patternId / 缺字段 → `GEMINI_INVALID_RESPONSE`,拒绝入库;
- 任何路径都不返回编造的分数,不降级为"跳过分析"。
