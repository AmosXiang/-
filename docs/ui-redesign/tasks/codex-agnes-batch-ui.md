# 任务书（Codex）：批量生成入口的 Agnes 路由适配（纯前端包）

> 全文直接粘贴给 Codex。上下文自包含。
> 背景：单镜生成的 Agnes 路由适配已合入真机 PASS（`cd8ae61`→`4b0fc26`，见 `evidence/agnes-image-ui-adapt-acceptance.md`）。批量入口当时明确顺延——现状：批量按钮（step3 工具栏 + 右栏「一键生成缺失分镜」）被 `!isComfyConnected` 置灰，`handleBatchGenerate`（src/App.tsx ~L1196）走 `POST /api/comfyui/shots/generate-all`（preflight→confirmed 两段，服务端在 server.ts，**全部**入 comfyui_tasks 本地队列，不经 provider 路由）。ComfyUI 离线时空镜也无法批量，而空镜单镜已可走 Agnes。
> 既有可复用事实（勿重建）：①preflight 响应 `preflight.items[]` 已含逐镜 `matchedCharacters`（空数组 = 无人物 = Agnes 可达）与 `missingAvatar`；②单镜端点 `/api/generate-image`（无 forceProvider）服务端路由：空镜→Agnes 同步 `{provider:'agnes', imageUrl}`；③服务端已有 Agnes 图片令牌桶限流（1k 档 20 rpm，排队等待上限 120s）与逐镜并发 409 锁——**前端串行调用时这些全部天然生效，前端不得自建限流**。
> 分工：本包归你（coding+验证+提交）；CC 逐行 review + 真机回归（真实 Agnes）。
> 基线 `feature/camera-derive@4b0fc26`。分支：`git worktree add -b feat/agnes-batch-ui ../wt-agnes-batch 4b0fc26`（强制独立 worktree）。

## 一、产品语义拍板（CC 定，可复议；越界即返工）

- **ComfyUI 在线：批量行为一字不改**（现状 = 全部入本地队列，含空镜——本地能力可用时不分流，避免行为漂移）。
- **ComfyUI 离线 + regenerateMode==='missing'**：批量按钮解除置灰 → 点击后走「离线 Agnes 批量」：
  1. 仍先调 generate-all **preflight**（不带 confirmed，现状请求，服务端不建任务）拿 `preflight.items`；风格契约未锁的既有 alert 分支维持不变。
  2. 前端拆分：`agnesTargets` = `matchedCharacters.length===0` 的镜；其余（含人物 / missingAvatar）为 `skipped`。
  3. 确认层（`window.confirm` 即可，沿用现有批量确认风格）三个数字分开：「可经 Agnes 云端生成：N 镜 / 跳过（需本地 ComfyUI）：M 镜 / 预计耗时：约 N × 45 秒（串行，浏览器页面需保持打开）」。
  4. 确认后**前端串行**逐镜 `POST /api/generate-image`（请求体与单镜生成路径**逐字段一致**——直接复用/提取 `handleGenerateShotImage` 内 comfyui 分支的 body 构造，禁止另写一份漂移副本；不带 forceProvider）。
  5. 每镜完成即用既有 `applyAgnesShotImage` 落卡；进度反馈复用 `shotCharacterFeedback`（如「Agnes 批量：3/12 完成，1 失败」）；单镜失败（含 409/超时/5xx）记入结果不中断后续。
  6. 提供**停止**：批量进行中把批量按钮改为「停止 Agnes 批量」，点击后完成当前镜即停；结束（完成/中止）后反馈汇总「完成 X / 失败 Y / 跳过 M（需本地 ComfyUI）」，失败明细逐镜列 shotIndex+错误信息（沿用现有 feedback 或轻量列表，不建新组件文件）。
- **ComfyUI 离线 + mode==='failed'/'all'**：维持置灰（重生成会覆盖已有图，云端批量重生成的语义另议）；tooltip 文案改为「该模式需本地 ComfyUI；缺失镜可离线经 Agnes 批量生成」。
- 离线 Agnes 批量**不引入**服务端新闸门（与单镜行为一致即为一致性基准）；也不改 generate-all 契约。

## 二、实现约束

- **纯前端**：只改 `src/App.tsx` 以下区域——`handleBatchGenerate`（或在其旁新增 `handleAgnesBatchGenerate` 并由现有两个按钮的 onClick 按连接状态分派）、两处批量按钮的 `disabled`/`title`/文案、新增的批量进度 state（计数/停止标志/失败列表，useState + useRef 即可）。
- 串行 = 前一镜 await 结束才发下一镜；**不并发**（并发会撞逐镜锁并挤兑限流队列）。
- 停止标志用 ref 检查（避免闭包陈旧状态）；组件卸载/项目切换时中止循环（现有 useEffect cleanup 模式）。
- `generatingShotIndex` 逐镜设置/复位，使当前镜卡片有加载态。
- 禁碰：server.ts、server/**、config/**、所有 components/**、index.css、router.ts、main.tsx；不加依赖。

## 三、验证与验收

- `npm run lint` + `npm run build`；全模块 60/60 + imageGen 10/10 不回归。
- 手测矩阵（stub 后端即可，**验收零真实计费**；真实 Agnes 留 CC）：
  | 场景 | 期望 |
  |---|---|
  | ComfyUI 在线 + missing 批量 | 走 generate-all 全流程，与基线行为逐步一致（回归项） |
  | 离线 + missing，含空镜与人物镜混合 | preflight → 确认层三数字 → 仅空镜串行发单镜请求，人物镜跳过并计入汇总 |
  | 离线批量中途某镜 500/409 | 记失败继续，汇总含逐镜错误 |
  | 离线批量中点停止 | 当前镜完成后停，汇总正确 |
  | 离线 + failed/all 模式 | 按钮仍置灰，tooltip 新文案 |
  | 风格契约未锁 + 离线 missing | 既有 alert 分支不回归 |
- 证据：`docs/ui-redesign/tasks/evidence/agnes-batch-ui-acceptance.md`（含每场景记录与请求体一致性说明——指明 body 构造与单镜路径的复用方式）。
- 提交前缀 `feat(image-ui): ...`，不 push，完成通知 CC。

## 四、CC 后续（非 Codex 范围）

真机：离线 + 真实 Agnes 批量 2-3 空镜（观察限流器排队与进度）；在线批量回归（若 ComfyUI 可起）；停止/失败路径抽查。远期关联遗留：服务端离线入队语义、路由配置热加载（独立 server 包评估时一并考虑「批量也走服务端路由拆分」的长期方案——本包是前端过渡形态，届时可整体替换）。
