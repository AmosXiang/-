# 任务书（Codex）：P3 风格契约后端模块 + 契约编辑/只读组件（WP-G）· v1.1

> 全文直接粘贴给 Codex。上下文自包含。
> 方案依据：`docs/ui-redesign/workflow-redesign-2026-07-14.md` §六（画风统一 = 风格契约）+ `tasks/integration-plan-2026-07-14.md` 裁决 #3。
> **v1.1 修订（2026-07-15，吸收架构复审 7 条）**：把"只存数据"的契约改为"真约束生成"的契约——核心是 `resolveEffectiveStyleContract` 进入生成链路 + 契约只锁**当前工作流真能生效**的字段。
> 基线 `feature/camera-derive@ef51af7`。分支 `feat/style-contract`（**尚不存在，须建**）。**强制独立 worktree**：
> `git worktree add -b feat/style-contract ../wt-style-contract ef51af7`

## 背景与核心原则

用户痛点：「ComfyUI 高级调整怎么保证各分镜画风统一」。方案 §六：**风格是项目级契约，分镜只许动结构，不许动风格。**

**关键事实（复审已核实，决定本任务边界）**：当前执行用的 API workflow 注入器 `applyPresetParameters`（server.ts）**只支持** prompt / seed / width / height / strength / loraStrength——**sampler / steps / CFG / checkpoint / 任意 LoRA 列表都烘在所选 workflow 预设模板里，不可注入**。因此：

> **裁决（用户 2026-07-15 确认）：预设即风格引擎。** 契约只锁**真能生效**的字段：`storyboardPresetId`（选定的工作流预设，它已隐含 checkpoint/sampler/steps/CFG）+ `styleOverlay` + `width/height` + 单一 `loraStrength`。sampler/steps/CFG/checkpoint 名称等作为**该预设的只读派生信息**展示（"由预设决定"），**不作为可编辑契约字段**，避免"看起来锁了、实际没用"的假能力。

本任务授权范围：后端新模块 + **两个新建前端组件文件** + **一个供 CC 核心 server.ts import 的纯解析函数**。前端热区 App.tsx/index.css/router.ts/main.tsx 与核心生成链路仍归 CC。

## 一、数据模型（GeneratedScriptRecord 上的可选 JSON 字段，store 文档内，禁止建表）

```ts
// src/types.ts — GeneratedScriptRecord 追加（你提交）
styleContract?: {
  version: number;        // 从 1 起；仅"风格字段"实质变更(PUT 且内容有变)时 +1；lock/unlock 与 no-op PUT 都不 bump
  locked: boolean;        // 批量生成闸门
  updatedAt: string;      // ISO8601
  storyboardPresetId: string;   // 工作流预设 id(= comfyuiPreferences.shotPresetId)；来自 /api/comfyui/presets?purpose=storyboard
  styleOverlay: string;         // 注入 prompt 的风格 overlay(= artDirection.overlay)
  width: number;                // 256..2048，8 的倍数
  height: number;               // 256..2048，8 的倍数
  loraStrength: number;         // 0..2；预设支持 LoRA 时生效,否则无副作用
};
```
sampler/steps/CFG/checkpoint 名称**不存进契约**——由前端只读组件按 `storyboardPresetId` 现查 preset 元数据展示。
旧项目无 `styleContract` 字段 = **未初始化**，须优雅处理（`GET` 返回派生初稿、不落库）。

## 二、后端模块 `server/modules/style-contract/`（结构照抄 story-version/shot-review）

写库走注入的 `mutateDb`、读库走注入的 `readDb`（参照 story-version 的 deps 注入）。错误 4xx + machine-readable `code`，不静默降级。

### API（路径锁定）

1. `GET /api/generated-scripts/:id/style-contract`
   - 已初始化：`{ initialized:true, version, locked, updatedAt, contract:{…全字段} }`；
   - 未初始化：`{ initialized:false, version:0, locked:false, contract:<派生初稿> }`。
     **派生初稿口径（锁定，不落库）**：`storyboardPresetId` = 该项目 `comfyuiPreferences.shotPresetId`（无则空串）；`styleOverlay` = `artDirection.overlay`（无则空串）；`width:1024, height:1024, loraStrength:1.0`。
   - 项目不存在 → 404 + code。

2. `PUT /api/generated-scripts/:id/style-contract` body `{ contract, lock? }`
   - **契约已 locked 时拒绝改字段** → `409 { code:'CONTRACT_LOCKED' }`（不能只靠前端置灰；解锁后才能 PUT）。
   - 校验（违规 400/422 + code）：`storyboardPresetId` 非空字符串；`styleOverlay` 字符串；`width/height` 整数、256..2048、可被 8 整除；`loraStrength` 数字 0..2。
   - **no-op 判定**：把归一化后的新 contract 与现有 contract 逐字段比较，**完全相同则不 bump version、不更新 updatedAt**，返回现值（幂等）。
   - 落库（一次 mutateDb 事务）：有变更则 `version+1`、`updatedAt=now`；`locked = lock ?? 现有 ?? false`；
     **write-through 单向回写**（契约为准）：同 record 上 `comfyuiPreferences = { ...现有, shotPresetId: contract.storyboardPresetId }`、`artDirection = { ...现有, overlay: contract.styleOverlay, updatedAt: now }`。
   - 返回 `{ success:true, version, locked, contract }`。

3. `POST /api/generated-scripts/:id/style-contract/lock` body `{ locked:boolean }`
   - 纯切换闸门，**version 不变、不回写、不改字段**；
   - `locked:true` 前跑完整性校验：未初始化或字段缺失/非法 → `422 { code:'CONTRACT_INCOMPLETE', missing:string[] }`；
   - 返回 `{ success:true, version, locked }`。

4. `GET /api/generated-scripts/:id/style-contract/preflight`
   - `{ ready:boolean, locked:boolean, missing:string[] }`，`ready = locked && missing.length===0`。供 CC 批量闸门二次校验用。

### 纯解析函数（导出给 CC 核心 server.ts import —— 让契约真进生成链路）

```ts
// server/modules/style-contract/index.ts 导出
export function resolveEffectiveStyleContract(readDb: () => any, projectId: string): {
  version: number;            // 未初始化 = 0
  locked: boolean;
  storyboardPresetId: string; // 未初始化回退 comfyuiPreferences.shotPresetId
  styleOverlay: string;       // 未初始化回退 artDirection.overlay
  width: number;              // 未初始化回退 1024（CC 侧再按既有默认兜底）
  height: number;
  loraStrength: number;       // 未初始化回退 1.0
}
```
纯读、无副作用；未初始化时**回退到旧字段**以兼容老项目。CC 会在 `prepareComfyTaskData`(shot/main) 与参数快照里调用它——**你只需保证该函数正确导出且可被 import**，其消费与快照落地由 CC 做（不在你范围）。

## 三、前端组件（新建文件，自包含，禁碰 App.tsx/index.css/router.ts/main.tsx）

样式跟随现有暗色工作台 tailwind（slate-900 系底、text-xs、rounded-xl）。返回类型交 TS 推断，**不写 `JSX.Element`**（仓库未装 `@types/react`）。不引新依赖/全局样式。

### 1. `src/components/StyleContractPanel.tsx`（② 风格设定的编辑 + 锁定）
```ts
export default function StyleContractPanel(props: { projectId: string; onLockedChange?: (locked: boolean) => void })
```
- 挂载 GET 契约；渲染可编辑字段：
  - **预设**：下拉，选项来自 `GET /api/comfyui/presets?purpose=storyboard`（**不要用文本框输入内部 id**）；
  - **风格 overlay**（多行）、**宽/高**（数字，步进 8）、**LoRA 强度**（0..2 滑块/数字）；
  - **只读派生区**：按当前所选预设展示 checkpoint 名/sampler/steps/CFG（现查预设元数据，取不到就显示"由预设决定"占位），标注"由预设锁定，不单独可调"；
- 顶部"风格契约 v{n}"+ 锁定态徽标；
- **原子"保存并锁定"**：dirty（有未保存改动）时禁用单独"锁定"按钮，或提供"保存并锁定"一步走——**绝不允许锁定未保存的表单内容**；
- 保存(PUT)→"已保存 v{n}"；锁定(POST lock)失败(422)把 `missing` 逐项高亮；锁定后字段置灰只读，解锁才可编辑；locked 时 PUT 返回 409 也要有明确提示；
- 锁定态变化调 `onLockedChange`；所有失败态明确展示；进行中禁用按钮。

### 2. `src/components/StyleContractReadonly.tsx`（检查器区③只读）
```ts
export default function StyleContractReadonly(props: { projectId: string })
```
- GET 契约，只读罗列 预设/overlay/宽高/LoRA 强度 + 该预设的 sampler/steps/CFG（现查，取不到显示占位）+ "v{n}·已锁定/未锁定"徽标；
- 未初始化空态"项目尚未设定风格契约"；失败态明确；
- 顶部一行"风格由项目契约统一控制，分镜仅可调结构参数"。

## 四、测试与验收

- 后端：`server/modules/style-contract/*.test.ts`（node:test + assert/strict，`:memory:` SQLite + 隔离 fixture，参照 story-version 测试基建）。至少覆盖：
  未初始化派生初稿（取 comfyuiPreferences/artDirection）、首次 PUT=v1、有变更 PUT 递增、**no-op PUT 不 bump**、**locked 时 PUT 返回 409**、lock/unlock 不改 version、锁定不完整契约 422+missing、preflight 的 ready/missing、write-through 回写 shotPresetId 与 overlay、坏输入 400/422（width 非 8 倍数、loraStrength 越界、storyboardPresetId 空）、**`resolveEffectiveStyleContract` 已初始化取契约值 / 未初始化回退旧字段**。
- 组件：`npm run lint` **且** `npm run build` 均过；可用性四项（键盘焦点可达、点击目标尺寸、文字对比度、缩放适配）在你自查范围内先过一遍，接线后 CC 复核。
- 验收证据：`docs/ui-redesign/tasks/evidence/style-contract-acceptance.md`（测试输出 + db 副本 curl 全流程：GET 未初始化 → PUT v1 → no-op PUT 不变 → PUT v2 → lock 成功 → locked 时 PUT 409 → unlock → 锁定不完整 422 → preflight → 验证 write-through 已回写旧字段）。

## 五、边界（违反即返工）

- server.ts 只许 1 行 import + 注册区 1 行 register；
- 前端只许新建两个组件文件 + `src/types.ts` 追加 `styleContract` 字段；**App.tsx / index.css / router.ts / main.tsx 禁碰**；
- 不碰 `shot-review|export-deck|camera-derive|shot-analysis|story-version`（引用其导出函数可以，改不行）；
- **以下明确不在你范围（CC 核心 server.ts 做）**：`resolveEffectiveStyleContract` 的**消费**（`prepareComfyTaskData` 读契约覆盖 preset/overlay/宽高/loraStrength）、参数快照落地（存完整生效值 + storyVersion/styleContractVersion + seed）、`generate-all confirmed=true` 的**服务端 enqueue 闸门**（未 ready 则零产物 + code）、旧 `/comfyui-preferences` 与脚本更新接口对契约拥有字段（shotPresetId/overlay）的**保护**、`Shot.basedOnStyleContractVersion` 落库与 isStale 派生。你只需导出正确的 `resolveEffectiveStyleContract` 与四个 API；
- 不建表、不加依赖、正式 db.sqlite 零污染；
- 提交前缀 `feat(style-contract): ...`，不 push，完成后通知协调人（CC）review 与接线。

## 六、CC 侧配套（记录在此，非你的活，供你理解全景）

1. `prepareComfyTaskData`(shot/main) 调 `resolveEffectiveStyleContract` 覆盖 preset/overlay/width/height/loraStrength；
2. 参数快照从"仅版本号+seed"扩为"完整生效契约 + storyVersion + styleContractVersion + seed"（CC 已落的 `generationSnapshotJson` 列扩展）；
3. `generate-all confirmed=true` 服务端二次校验 preflight，未 ready → `STYLE_CONTRACT_NOT_LOCKED` + missing + 零产物；单张试跑允许"已保存未锁定"契约；
4. 旧 `/comfyui-preferences` PUT 与脚本更新：契约已初始化时，保留契约拥有的 shotPresetId/overlay（忽略外部覆盖或返冲突）；character-master/three-view/identity/upscale 等其余预设设置**保留可编**（角色母版/三视图仍依赖，见 App.tsx ComfyUI 设置区）；
5. `Shot.basedOnStyleContractVersion` 落库；`isStale` 派生 = 故事版本或风格版本任一落后。
