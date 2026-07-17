# 任务书（Codex）：ComfyUI 离线入队 · server 包（含路由配置热加载）

> 全文直接粘贴给 Codex。上下文自包含。
> **热区特批**：本包按用户拍板破例开放 server.ts 两处列明区域（§二/§三），此外 server.ts 零改动；CC 逐行严审。这是 server.ts 首次对外包开放热区，越界即整包返工。
> 背景（真机实证，见 `evidence/agnes-image-ui-adapt-acceptance.md` CC 增补节）：
> ①`POST /api/generate-image` 的 ComfyUI 路径在建任务**前**做 `/system_stats` 预检，离线直接 `503 COMFYUI_UNAVAILABLE`（server.ts ~L7518，`comfyFetch('/system_stats', {}, 3_000)`）——任务不入队；
> ②队列 worker `submitComfyTask` 内 `assertComfyPreflight` 把 `!preflight.online` 当错误 throw，catch 后任务**直接标 failed**（server.ts ~L4134-4220）——即使任务已入队，离线期间也会被 worker 打死；
> ③前端 `handleGenerateShotImage` 的 taskId 分支已备好「任务已入队（id），但 ComfyUI 未连接，启动后才会开始执行」警示（cd8ae61 交付），当前仅 stub 可达——本包让它真实可达；
> ④路由配置 `config/imageGenRouting.json` 在 `registerImageGenRouting` 启动时读取一次，热改无效（真机实证，切 autoRoute 需重启）。
> 分工：本包归你（coding+验证+提交）；CC 逐行严审 + 真机回归。
> 基线 `feature/camera-derive@86b36d8`。分支：`git worktree add -b feat/comfy-offline-queue ../wt-offline-queue 86b36d8`（强制独立 worktree）。

## 一、目标语义（拍板）

ComfyUI 离线时，路由/强制到本地的分镜生图任务**照常入队**（pending + 等待态），ComfyUI 上线后 worker 自动开始执行；离线不再产生 503 拒绝，也不再被 worker 误标 failed。Agnes/Pollinations/Kling 路径行为零变化。

## 二、server.ts 热区 A：`/api/generate-image` 预检（约 L7514-7525）

- 删除「离线即 503」返回；改为探测结果仅记录：`comfyOnline: boolean` 进日志与响应体（`{ taskId, comfyOnline }`，字段可选消费，前端现有 runtime 查询逻辑不依赖它）。
- 探测失败时任务照常创建（pending，`stateDetail` 初值改为 `'waiting_for_comfyui'`；在线则维持现状初值）。
- 409 duplicate 检查、风格契约无关逻辑、Agnes 路由拦截（在本 handler 之前）一概不动。

## 三、server.ts 热区 B：worker 提交的等待语义（`submitComfyTask` 约 L4134-4220 + `startComfyWorker` 约 L4684-4735）

- `assertComfyPreflight` 本体不改。在 `submitComfyTask` 的 catch 中**区分错误类别**：错误信息匹配「ComfyUI 未连接」（即 `!preflight.online` 抛出的那条）→ **不判 failed**：任务回退 `status='pending'`、`stateDetail='waiting_for_comfyui'`、error 置 NULL、清 submittedAt；其余错误（多进程/dbLocked/权限/OOM/提交失败）维持现有 failed 逻辑逐字不变。
  - 实现允许改为在 catch 前显式捕获：对 preflight 结果先行 `if (!preflight.online)` 分支处理再 `assertComfyPreflight`，避免靠错误字符串匹配（推荐，语义清晰）。
- **离线退避**：worker 每 1.5s 一轮；任务处于等待态时不得每轮都打 `/system_stats`。在 worker 模块级加「上次离线探测时间戳」：距上次探测 < 30s 且上次离线 → 本轮直接跳过提交（任务保持 pending）。探测成功立即清零退避。
- 等待不设次数上限（用户可随时用现有取消按钮终止）；每次进入/离开等待态各打一条结构化日志（`[Worker] waiting_for_comfyui` / `resumed`），等待期间不逐轮刷日志。
- `pollActiveTasks` 与其余 worker 逻辑不动。

## 四、imageGen 模块：路由配置热加载（`server/providers/imageGen/**`，你的常规可改区）

- `registerImageGenRouting` 的配置读取改为按 `fs.statSync(configPath).mtimeMs` 缓存：mtime 变化才重读+重解析；解析失败保留上一份有效配置并打错误日志（禁止因坏配置炸路由）。
- 语义：改 `config/imageGenRouting.json` 后**下一次请求**生效，无需重启。routes.test.ts 加用例：改写临时 configPath 文件后同一进程内路由决策变化。

## 五、前端（`src/App.tsx`，仅列明两处）

1. 单镜「本地 ComfyUI」强制模式：移除 `forcedLocalUnavailable` 对生成按钮的禁用（选择器下方文案改为「本地 ComfyUI 未连接：任务将入队等待，启动后自动执行」，琥珀色保留）；点击后走既有 taskId 分支 → 现成的「已入队但未连接」警示如实展示。
2. `handleGenerateShotImage` taskId 分支与参数对话框/高级调整两处 forceProvider 强守卫**不动**（对话框维持阻断，显式本地操作语义不变）。

## 六、验证与验收

- 隔离环境：`SQLITE_DB_PATH` 临时库 + 临时 uploads 起服（先例照抄前几包），ComfyUI 全程不存在。
- 矩阵：
  | 场景 | 期望 |
  |---|---|
  | 离线 + forceProvider=comfyui_local 单镜 | 200/201 返回 taskId；任务 pending + `stateDetail='waiting_for_comfyui'`；无 503 |
  | 离线 + 自动路由含人物镜 | 同上（路由到 comfyui_local 后入队等待） |
  | 离线 + 自动路由空镜 | 仍走 Agnes 路径（stub），行为零变化 |
  | worker 离线运行 ≥90s | 任务保持 pending 不被标 failed；`/system_stats` 探测频率符合 ≥30s 退避（以日志计数证明）；无逐轮刷日志 |
  | 非 offline 类 preflight 错误 | 仍标 failed（用 stub/构造错误至少覆盖一类） |
  | 409 duplicate | 不回归 |
  | 配置热加载 | 测试用例：改临时 config 后下一请求路由决策变化；坏 JSON 不炸、沿用旧配置 |
  | 前端 | 离线强制本地按钮可点 → 入队 + 「已入队但未连接」警示；对话框阻断不回归 |
- `npm run lint` + `npm run build` + 全模块测试（60/60 + 新增）+ imageGen 测试（10/10 + 新增）。
- **诚实边界**：「ComfyUI 上线后自动恢复执行」无法在无真实 ComfyUI 环境验收（full preflight 还查端口进程/目录可写，假桩过不了）——证据中标 `UNVERIFIED / 留 CC 真机`，禁止用 mock 宣称已验证。
- 证据：`docs/ui-redesign/tasks/evidence/comfy-offline-queue-acceptance.md`。

## 七、边界（违反即返工）

- **允许改动**：server.ts **仅限 §二/§三两处热区**、`server/providers/imageGen/**` 及其测试、`src/App.tsx` 仅限 §五两处、证据文档。
- **禁碰**：server.ts 其余全部（含 video-lab/export-deck 注册区、Agnes 视频链路、ComfyUI runtime 管理）、server/modules/**、config/**（热加载实现读它，不改它）、components/**、index.css。
- 不建表、不改 schema、不加依赖；正式 db/uploads 零污染；真实 provider 计费调用零发生。
- 提交前缀 `feat(comfy-queue): ...`，不 push，完成通知 CC。

## 八、CC 后续（非 Codex 范围）

真机：离线入队 → 启动真实 ComfyUI → 观察 worker 自动恢复执行（本包唯一 UNVERIFIED 项）；autoRoute 热切换真机复验；单镜/批量/对话框回归。
