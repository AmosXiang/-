# 任务书（Codex）：分镜评审 / 定稿 / 版本机制后端 API（WP-B）

> 直接把本文件全文作为任务粘贴给 Codex 即可。上下文自包含。
> 所属方案：`docs/ui-redesign/workflow-redesign-2026-07-14.md` §四；共享契约与禁改清单：`docs/ui-redesign/tasks/README.md`（以其为准，冲突时契约文件优先）。

## 背景

本项目是本地导演工作台（React 19 + Vite 前端，Express `server.ts` 后端，better-sqlite3）。创意项目（generatedScript）的分镜（shot）通过 ComfyUI 反复生成图片，每次生成在 SQLite `comfyui_tasks` 表留有任务行（含 prompt 快照、seed、结果图 URL、状态、时间）。当前缺少"评审→定稿"机制：用户无法在多次生成结果中挑选定稿版本，导出时也无法区分草稿与定稿。你的任务是补齐这套机制的**纯后端 API**（前端由另一 agent 后续对接，你不要写任何前端代码）。

## 数据模型事实（重要，读码前先知道）

- **没有 shots 表**。分镜存于 `store` 键值表 `key='generated_scripts'` 的 JSON 文档内：`generated_scripts[].newShots[]`，shot 主键为字符串 `id`。**禁止新建表、禁止改表结构。**
- Shot 上追加可选 JSON 字段是既定模式（参照 camera-derive 模块给 Shot 加 `cameraH`/`isMaster` 等字段的做法，`src/types.ts` 有注释说明）。旧数据无字段即未设置，天然兼容。
- 模块化后端的标准姿势：`server/modules/camera-derive/`（index.ts 导出 register 函数，routes.ts 挂路由，workflow.ts 纯逻辑，workflow.test.ts 测试）。注册点在 `server.ts` 底部 L7407 附近。**照抄这个结构。**

## 交付物

新模块 `server/modules/shot-review/`，并实现：

### 1. Shot 字段（在 `src/types.ts` 的 Shot 接口追加，这是你唯一允许改的前端文件）

```ts
finalTaskId?: string;        // 定稿版本对应的 comfyui_tasks 任务 id
finalizedImageUrl?: string;  // 定稿图 URL（冗余存储，导出模块只读此字段）
isStale?: boolean;           // 上游（故事/风格/角色）变更后被标记过期
```

### 2. API（路径已在共享契约锁定，不得更改）

1. `GET /api/generated-scripts/:id/shots/:shotId/versions`
   从 `comfyui_tasks` 按该 shot 聚合历史生成版本，返回
   `{ versions: [{ taskId, imageUrl, prompt, negativePrompt, seed, model, status, createdAt, isFinal }] }`，
   按 createdAt 倒序；`isFinal` = taskId === shot.finalTaskId。先读现有任务表结构与按 shot 关联的既有查询（`/api/comfyui/tasks`、shot 批量生成相关代码）确认关联字段，不要凭猜。
2. `PUT /api/generated-scripts/:id/shots/:shotId/final`（body `{ taskId }`）
   校验该 task 存在、属于该 shot、状态为成功且有结果图，**且结果图为 `/uploads/...` 本地路径、
   解析后位于 UPLOADS_DIR 内、文件真实存在**（防止定稿指向远程/失效资源）；
   通过后**只写入** `finalTaskId` + `finalizedImageUrl`。
   **不得触碰 `isStale`**——定稿一个旧版本不代表它变成了基于当前输入生成；
   新鲜度只由 stale-check / mark-stale 流程管理（三个正交维度互不覆盖）。
   非法输入返回 400 与明确错误信息，不静默降级。
3. `DELETE /api/generated-scripts/:id/shots/:shotId/final` — 取消定稿（清除两字段）。
4. `POST /api/generated-scripts/:id/stale-check`
   对每个已有成功生成结果的 shot，比对"生成当时的 prompt 快照"（任务行 prompt 列 / `presetParametersJson`，机位派生另有 `cameraPromptUsed` 先例）与"按当前项目数据将会生成的 prompt"是否一致，返回 `{ staleShots: [{ shotId, reason }] }`。只读，不写库。若现有 prompt 组装逻辑难以复用，允许退化为"比对任务快照与 shot 当前 description/结构参数字段"，但要在代码注释与验收文档中如实说明判定口径。
5. `PUT /api/generated-scripts/:id/shots/mark-stale`（body `{ shotIds: string[], isStale: boolean }`）— 批量写 `isStale`。

### 3. 测试

`server/modules/shot-review/*.test.ts`，Node 内置 `node:test` + `assert/strict`（风格照抄 `server/modules/camera-derive/workflow.test.ts`）。至少覆盖：定稿写入与校验拒绝（task 不存在/不属于该 shot/未成功/结果图非本地或文件缺失）、**定稿与取消定稿均不改变 `isStale`**、旧数据（无新字段）兼容、mark-stale 批量、versions 排序与 isFinal 标记。

### 4. 验收证据

`docs/ui-redesign/tasks/evidence/shot-review-acceptance.md`：测试输出、对一个真实项目的 curl 全流程演示（versions → final → versions 里 isFinal 变化 → delete → stale 流程）。

## 边界（违反即返工）

- `server.ts` 只允许：顶部 1 行 import + L7407 注册区 1 行 register 调用。
- 除 `src/types.ts` 的 Shot 接口追加外，**不碰任何 `src/**` 文件**（App.tsx、index.css、main.tsx、components 一律禁改）。
- 不碰 `server/modules/export-deck/`（另一 agent 的并行工作区）、不碰既有端点逻辑、不新建 SQLite 表、不写迁移。
- 不装新依赖。
- 分支 `feat/shot-review-api`，基线 commit 以协调人（Claude Code）通知为准；提交信息用 `feat(shot-review): ...` 前缀。
