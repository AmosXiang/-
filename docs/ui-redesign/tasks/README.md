# UI 重设计 v2 — 多 Agent 分工协调表

> 方案依据：[workflow-redesign-2026-07-14.md](../workflow-redesign-2026-07-14.md)（v2 定稿）。
> 分工原则：**按冲突区切分**。前端热区（`src/App.tsx` 6881 行单组件 + `src/index.css`）任一时刻只允许一个 agent 修改；后端走已验证的模块注册模式（参照 `server/modules/camera-derive/`），各 agent 在自己的模块目录内工作，对 `server.ts` 的改动限定为底部注册区各加两行。

## 分工与依赖

```
WP-A  P0 前端止血            Claude Code   ──→  WP-D  P1 路由化拆页 (CC)  ──→  P2 前端联调 (CC)
WP-B  定稿/版本机制 API      Codex         ─────────────────────────────────↗
WP-C  导出交付包 API         Antigravity   ─────────────────────────────────↗
```

- WP-A / WP-B / WP-C **三路并行**，互不接触对方文件。
- WP-D（P1 路由化）依赖 WP-A 合入；P2 前端（检查器五区重组、定稿 UI、故事编辑、导出页）依赖 WP-D + WP-B/WP-C 的 API 就绪。
- 任务书：Codex → [codex-shot-review-api.md](codex-shot-review-api.md)；Antigravity → [antigravity-export-deck.md](antigravity-export-deck.md)。

## 分支与基线

| 工作包 | 分支 | 状态（2026-07-14 晚） |
| --- | --- | --- |
| WP-A P0（CC） | 随基线入库 `0d5c452` | ✅ 完成 |
| WP-D P1 第一批（CC） | `feat/p1-routing@52fd81c` | ✅ 完成并真机验证 |
| WP-B (Codex) | `feat/shot-review-api@18af37d` | ✅ PASS 待合入 |
| WP-C (Antigravity) | `feat/export-deck-api@b539ecb` | ⚠️ 视觉验收 FAIL，修复中（见集成计划批次 0） |

**后续以 [integration-plan-2026-07-14.md](integration-plan-2026-07-14.md) 为准**（合并顺序、设计裁决、批次表、协作纪律）。

**统一基线已建立（2026-07-14）**：脏工作区已按三个提交落库——`f846ece`（此前会话
video-generation/工作台改动 + 配套源文件）、`0d5c452`（P0 止血）、`3a0c0b5`（方案 v2.1 +
任务书 + 验收证据）。WP-B / WP-C 从 `feature/camera-derive` 最新 HEAD 拉分支即可开工。

## 共享契约（三方都必须遵守，改动需回到本文件更新）

### 1. Shot JSON 新增字段（延续 camera-derive 的可选字段模式，旧数据零迁移）

```ts
// src/types.ts — Shot 接口追加（由 WP-B 提交；WP-C 只读不写）
finalTaskId?: string;        // 定稿版本对应的 comfyui_tasks 任务 id
finalizedImageUrl?: string;  // 定稿图 URL（冗余存储，避免导出时联查）
isStale?: boolean;           // 上游（故事/风格/角色）变更后被标记过期
```

分镜展示状态按**三个正交维度派生**，均不落库额外字段：
- **评审状态**（未生成/待评审/已定稿）：由版本存在性与 `finalTaskId` 派生；
- **输入新鲜度**（当前/基于旧输入）：由 `isStale` 派生；
- **当前任务**（空闲/排队/生成中/失败）：由 comfyui_tasks 实时态派生。
三维互不覆盖——已定稿镜头再生成新版本时仍是"已定稿"，新版本失败不改变定稿；`isStale` 不清除定稿，只叠加"基于旧输入"标注。

### 2. 数据访问

分镜存于 SQLite `store` 表 `key='generated_scripts'` 的 JSON 文档（`generated_scripts[].newShots[]`），**没有 shots 表，禁止新建表**。读写方式参照 `registerCameraDeriveModule`（server.ts:7408）通过注册函数注入的 helper。

### 3. server.ts 修改限定

每个后端工作包在 server.ts 只允许：顶部加 **1 行 import**、底部 L7407 注册区加 **1 行 register 调用**。其余逻辑一律放自己的 `server/modules/<name>/` 目录。

### 4. API 路径（已锁定，前端将按此对接）

WP-B（Codex）：
- `GET    /api/generated-scripts/:id/shots/:shotId/versions`
- `PUT    /api/generated-scripts/:id/shots/:shotId/final`（body `{ taskId }`）
- `DELETE /api/generated-scripts/:id/shots/:shotId/final`
- `POST   /api/generated-scripts/:id/stale-check`
- `PUT    /api/generated-scripts/:id/shots/mark-stale`（body `{ shotIds: string[], isStale: boolean }`）

WP-C（Antigravity）：
- `GET  /api/generated-scripts/:id/delivery-check`
- `POST /api/generated-scripts/:id/export-deck`

### 5. 禁改清单（WP-B / WP-C 共同遵守）

- `src/**` 全部前端文件（含 App.tsx、index.css、main.tsx、components/**）——唯一例外：WP-B 在 `src/types.ts` 的 Shot 接口追加上述三个可选字段；
- server.ts 既有端点逻辑（只许注册区加行）；
- `db.sqlite` 表结构；`uploads/` 既有文件；
- 对方模块目录（`server/modules/shot-review/` ↔ `server/modules/export-deck/`）。

### 6. 测试与验收约定

- 测试框架：Node 内置 `node:test` + `assert/strict`，测试文件与模块同目录（`*.test.ts`），风格参照 `server/modules/camera-derive/workflow.test.ts`；
- 每个工作包交付时附验收证据 markdown 至 `docs/ui-redesign/tasks/evidence/`（本仓库惯例，参照 `docs/camera-derive/ACCEPTANCE.md`）；
- 日志与提交中不得出现 API Key / Authorization（仓库卫生规则见 `docs/video-providers/agnes-video-v2.md`）。
