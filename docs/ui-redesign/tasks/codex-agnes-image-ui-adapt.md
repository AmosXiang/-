# 任务书（Codex）：Agnes 图片路由 · 新创作向导前端适配

> 全文直接粘贴给 Codex。上下文自包含。
> 背景：Agnes 静态图片 Provider 与配置路由（`config/imageGenRouting.json`，autoRoute=true：主帧/含人物→comfyui_local、空镜→agnes 同步）已在 origin/main 验收合并（PR #1/#3/#4/#5），并已由 CC 合回 `feature/camera-derive`（合并提交 `e2ee9e1`，后端在本分支直调 API 端到端验证通过：`POST /api/generate-image` 无 forceProvider → `{provider:"agnes", imageUrl}` 同步落盘 + shot 审计字段写入）。
> **本包要修的是一个真实存在的语义错位**：PR #3 的前端适配写给旧版 App；重设计后的新创作向导在 `handleGenerateShotImage` 里独立加了「ComfyUI 未连接即 throw」的前置守卫（src/App.tsx ~L2378-2381，`runtime.connected` 检查），它早于路由存在——ComfyUI 离线时请求根本发不出去，**Agnes 路由在新 UI 里不可达**（CC 真机复现：点击生成零网络请求）。自动合并进来的 agnes 分支处理代码（`applyAgnesShotImage`、409 provider 检查、`taskResult.provider==='agnes'` 分支）本身完好，只是被守卫挡在外面。
> 分工：本包归你（coding+验证+提交）；CC 负责逐行 review、真机回归（含真实 Agnes 调用）。
> 基线 `feature/camera-derive@e2ee9e1`。分支：`git worktree add -b feat/agnes-image-ui-adapt ../wt-agnes-ui e2ee9e1`（强制独立 worktree）。

## 一、范围拍板（越界即返工）

**做**：①单镜生成路径的守卫下移（见 §二，本包核心）；②Agnes 结果/错误反馈核对补齐；③平台选择器路由说明文案。
**不做**：批量生成入口（"一键生成缺失分镜"/批量按钮维持 ComfyUI-only 现状，其守卫**不动**——批量路径走专用 Comfy 队列端点，不经路由，适配需独立方案，后续包）；路由规则前端复制（服务端是唯一权威）；`forceProvider=comfyui_local` 两处调用（参数对话框、高级调整）的强守卫**保留不动**（显式本地操作，语义正确）；server/**、config/** 零改动。

## 二、守卫下移（核心改动，src/App.tsx `handleGenerateShotImage` 内）

**现状**（imagePlatform==='comfyui' 分支）：先 GET `/api/comfyui/runtime`，`!runtime.connected` 即 throw，中止一切。

**目标语义（CC 拍板，可复议）**：前端不预判 provider——路由权威在服务端。

1. 移除「未连接即 throw」的前置阻断；直接 POST `/api/generate-image`（不带 forceProvider，请求体现状不变）。
2. 响应分派维持既有三路：
   - `provider==='agnes' && imageUrl` → `applyAgnesShotImage`（既有函数，勿改）+ 成功反馈（既有文案）；
   - `taskId`（被路由进本地 Comfy 队列）→ **此时才**查 runtime：未连接则反馈改为警示型「任务已入队（{taskId}），但 ComfyUI 未连接，启动后才会开始执行」；已连接则维持既有成功文案 + `pollComfyTasks()`；
   - 409：`err.provider==='agnes'` 与 `err.existingTaskId` 两个既有分支维持不变。
3. runtime 查询失败（后端不可达）不得吞错：维持现有 catch → 错误反馈路径。
4. `setGeneratingShotIndex` 的加载态/finally 复位保持现有结构（M3 合并后该函数内有重复 `setGeneratingShotIndex(idx)`，顺手去重，行为不变）。

**改动半径约束**：只允许动 `handleGenerateShotImage` 函数体内 imagePlatform==='comfyui' 分支 + 该函数内已存在的重复行去重。函数签名、其他分支（pollinations/kling 路径）、`applyAgnesShotImage` 一概不动。

## 三、反馈与文案（小项）

1. 生图平台选择器（`imagePlatform` combobox）`comfyui` 选项旁/下方加一行说明（样式沿用现有 slate 辅助文案）：「已启用配置路由：空镜 → Agnes 云端（同步），主帧/含人物 → 本地 ComfyUI」。文案仅在 autoRoute 生效时显示——前端无配置读取端点，**静态显示即可**（配置以 `config/imageGenRouting.json` 为准的措辞规避硬编码规则细节）。
2. Agnes 生成中的加载态复用现有 `generatingShotIndex` 机制（已有，验证即可，勿新造状态）。

## 四、验证与验收

- `npm run lint` + `npm run build` 全过；全模块测试 60/60 + imageGen 10/10 不回归（跑法：模块 `npx tsx --test`；imageGen `node --experimental-transform-types --test server/providers/imageGen/*.test.ts`）。
- 前端无组件测试基建，行为验证以手测矩阵留证（截图/文字记录进证据文档）：
  | 场景 | 期望 |
  |---|---|
  | ComfyUI 离线 + 空镜（无匹配角色、非主帧）生成 | 请求发出 → Agnes 同步落图上卡 + 成功反馈 |
  | ComfyUI 离线 + 含人物镜头生成 | 请求发出 → 返回 taskId → 警示反馈「已入队但 ComfyUI 未连接」 |
  | ComfyUI 在线 + 含人物镜头生成 | taskId + 既有成功文案 + 轮询启动 |
  | Agnes 并发第二次点击同一镜头 | 409 → 「该分镜已有 Agnes 生成进行中」 |
  | 参数对话框 / 高级调整 | 仍带 forceProvider=comfyui_local，且 ComfyUI 离线时维持原阻断行为 |
- 手测可用 stub：真实 Agnes 调用留给 CC 真机（你手测 Agnes 成功路径可临时用本地 mock 服务或以 CC 已验证的直调证据引用替代，**不得在验收中产生真实计费调用**；Agnes 离线态的失败路径手测即可）。
- 证据：`docs/ui-redesign/tasks/evidence/agnes-image-ui-adapt-acceptance.md`。

## 五、边界（违反即返工）

- **允许改动**：`src/App.tsx` 仅限 §二/§三列明区域、证据文档——此外零改动（热区规则：CC 逐行严审）。
- **禁碰**：server.ts、server/**、config/**、index.css、router.ts、main.tsx、所有 components/**；不加依赖、不建测试基建。
- 正式 db/uploads 零污染；真实 provider 计费调用零发生。
- 提交前缀 `fix(image-ui): ...`，不 push，完成通知 CC。

## 六、CC 后续（非 Codex 范围）

真机回归：ComfyUI 离线 + 空镜 → 真实 Agnes 同步落图（新 UI 全链路，补上 CC 本轮只验了直调 API 的缺口）；含人物镜头入队警示；参数对话框阻断不回归；autoRoute=false 回退开关抽查。批量入口适配另行评估立项。
