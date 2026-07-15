# 任务书（Codex）：P3.5 场景参考轻量版 + P3 三小项（WP-I）

> 全文直接粘贴给 Codex。上下文自包含。
> 方案依据：`workflow-redesign-2026-07-14.md` §六 + `integration-plan-2026-07-14.md` 裁决 #4：**轻量版**——项目可传场景参考图 + 分镜标场景标签 + 生图时 overlay 注入；**不建"场景工坊"**，撞到不够再扩。
> 分工：本包归你（coding+验证+提交）；同期 Antigravity 做交付包 `scenes/` 目录（WP-J，读你定的数据模型，防御式处理字段缺失——**数据契约锁定后不得单方改形状**）。CC review。
> 基线 `feature/camera-derive@325f2ba`。分支：`git worktree add -b feat/scene-reference ../wt-scene-reference 325f2ba`（强制独立 worktree）。

## 一、数据契约（store JSON，禁建表；WP-J 同时依赖，形状锁定）

```ts
// src/types.ts — GeneratedScriptRecord 追加
sceneReferences?: Array<{
  id: string;          // UUID
  name: string;        // 场景名，如"豪宅客厅"
  imageUrl?: string;   // /uploads/... 场景参考图（可无）
  overlay?: string;    // 场景 overlay 英文提示词（手填或后续提取；可无）
  updatedAt: string;   // ISO8601
}>;

// Shot 追加
sceneId?: string;      // 关联 sceneReferences[].id；无 = 未标场景
```

旧项目无字段 = 空列表，全部优雅处理。

## 二、后端模块 `server/modules/scene-reference/`（结构照抄 style-contract）

deps 注入 `readDb`/`mutateDb`/`uploadsDir`；错误 4xx + machine-readable `code`。

1. `GET /api/generated-scripts/:id/scene-references` → `{ scenes: [...] }`（无字段返 `[]`）；404 项目不存在。
2. `PUT /api/generated-scripts/:id/scene-references` body `{ scenes }` —— 整表替换式 upsert：
   校验每项 `name` 非空字符串、`overlay` 若有为字符串（≤2000 字符）、`id` 缺失补 UUID、`imageUrl` **只读透传**（只能经上传端点写入；请求中未知 imageUrl 值以现存记录为准，防伪造路径）；场景数上限 20；返回落库后全表。
3. `POST /api/generated-scripts/:id/scene-references/:sceneId/image` —— multipart 上传参考图（模块内自建 multer 实例、写入注入的 uploadsDir 下 `scene-refs/` 子目录；仅收 image/*，≤10MB）；更新该场景 `imageUrl` 与 `updatedAt`；404 场景不存在。
4. `PUT /api/generated-scripts/:id/shots/:shotId/scene` body `{ sceneId: string | null }` —— 轻量打标（**不走 storyboard enrichment 校验**，那个端点要求全量结构字段）；`sceneId` 非 null 时必须命中现存场景否则 422 + code；null = 摘除标签；返回更新后的 shot。
5. 删除场景时（PUT 整表中移除）：**不级联清 shot.sceneId**（生成时按"查无此场景=不注入"处理），但响应附 `orphanedShotCount` 供 UI 提示。

## 三、核心 server.ts（限以下两点）

1. **生成注入**（prepareComfyTaskData，shot/main 分支、风格契约 overlay 注入之后）：
   shot 有 `sceneId` 且命中场景且该场景 `overlay` 非空 → 追加
   `Scene reference (environment only; preserve shot content, composition and characters): ${overlay}`；
   幂等口径与风格 overlay 相同（优化后注入、includes 判重）。场景无 overlay 或查无场景 → 静默跳过（imageUrl 本期**不**做图像 conditioning，纯文本 overlay——轻量版边界）。
2. **快照**：`buildShotGenerationSnapshot` 增 `scene: { id, overlay } | null`。

## 四、前端（App.tsx 热区放权区域 + 新组件）

1. **新组件 `src/components/SceneReferencePanel.tsx`**：场景列表管理（增删、名称、overlay 多行、上传参考图带缩略与失败占位）；样式随暗色工作台；不写 `JSX.Element`。挂载：风格设定步骤 StyleContractPanel 下方（仅 generatedScript 存在时）。
2. **分镜打标**：检查器区①「分镜摘要」内加"场景"下拉（选项=场景列表+「未标注」），改动调打标端点并更新本地 state。
3. **区③补充**：StyleContractReadonly 下方一行显示当前分镜场景名（无则"未标注场景"）——只读一行，不引组件。

## 五、P3 三小项（顺手修，随本包提交）

1. 快照 effective 归一：`storyboardPresetId: x || null` → 与其余字段统一 `?? null`（空串语义保留）；
2. `DEFAULT_COMFY_NEGATIVE_PROMPT` 去重：迁至 `server/constants/comfyDefaults.ts` 导出，server.ts 与 App.tsx 双端 import（先例：CameraDerivePanel import cameraVocab）；
3. 高级调整模态 negative 角注文案："由项目风格契约控制" → "由项目统一默认控制"（契约 v1.1 实无 negative 字段，文案对齐事实）。

## 六、测试与验收

- 模块测试（node:test + `:memory:` + mkdtemp uploads 隔离）：空列表、upsert 校验（name 空/超限/伪造 imageUrl 被拒/补 UUID）、上传写盘与 imageUrl 更新、打标命中/422/摘除、删除场景 orphanedShotCount；
- 核心注入验收走 db 副本 curl：标场景的 shot 单张 enqueue → 任务 prompt 含 scene 语句恰一次、快照含 scene 字段；未标/场景无 overlay → 不注入；
- `npm run lint` + `npm run build`；真机联调 CC 执行；
- 证据：`docs/ui-redesign/tasks/evidence/scene-reference-acceptance.md`。

## 七、边界（违反即返工）

- server.ts 限：1 import + 1 register + §三两点 + §五小项 1/2；App.tsx 限：§四 2/3 + §五小项 2/3 触点；
- 禁碰 router.ts/main.tsx/其他模块；style-contract 模块只读引用；
- 不建表、不加依赖（multer 已有）、正式 db.sqlite 与 uploads 正式目录零污染；
- 提交前缀 `feat(scene-reference): ...`（P3 小项可单独 `chore(p3-followup): ...` 提交），不 push，完成通知 CC。
