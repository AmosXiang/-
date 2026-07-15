# 任务书（Codex）：P3 接线批 — 契约进生成链路 + 检查器五区重组（WP-H）

> 全文直接粘贴给 Codex。上下文自包含。
> **协作新规（2026-07-15 用户拍板）**：前端热区（App.tsx 等）向 Codex 放权，CC 逐行严审。本任务书列明的触碰范围即授权边界——范围外的 App.tsx 区域一行都别动。
> 方案依据：`docs/ui-redesign/workflow-redesign-2026-07-14.md` §三(检查器五区)/§六(风格契约)；`tasks/codex-style-contract.md` v1.1 §六（CC 配套清单，本任务即其落地）。
> 基线 `feature/camera-derive@88b4599`（含你的 WP-G ecd207c 与 CC 的参数快照 22e9e2c）。
> 分支：`git worktree add -b feat/p3-wiring ../wt-p3-wiring 88b4599`（**强制独立 worktree**）。

## 目标一句话

让已合入的风格契约**真正约束生成**（resolver 进链路、快照存完整生效值、批量服务端闸门、旧入口保护），并把分镜检查器重组为方案 §三 的五区结构。

---

## A. 后端（核心 server.ts —— 指定改动点，别处勿动）

### A1. resolver 进生成链路（`prepareComfyTaskData`）

`prepareComfyTaskData`（搜索函数名定位）内，`targetType === 'shot'`（viewType 解析后为 `'main'`）路径：

1. 函数开头解析出 projectId 后，调用 `resolveEffectiveStyleContract(readDb, String(projectId || ''))`。
   **必须 try/catch 包裹**：它对不存在的项目会 throw `PROJECT_NOT_FOUND`（StyleContractError）——catch 后回退为"无契约"行为（沿用现逻辑），**绝不能让角色/非项目上下文的生成因此挂掉**。
2. shot/main 时用生效值覆盖：
   - `selectedPreset` 的 shot 分支：以 `effective.storyboardPresetId` 取代 `projectPreferences.shotPresetId`（**注意：identity preset 的角色一致性覆盖逻辑保持原样、且优先级更高**——`lockCharacterIdentity && characterReference.sourceImageUrl` 时仍切 identityPresetId，契约只接管"普通 shot 预设"这一层）；
   - `width/height`：shot/main 时以契约值为准，**忽略请求里的 reqWidth/reqHeight**（"分镜只许动结构，不许动风格"——分辨率属风格）。现有的 64 对齐 clamp 逻辑保留，对契约值同样适用；
   - `loraStrength`：shot/main 时传 `effective.loraStrength` 进 `applyPresetParameters`（现有单值注入能力，预设无 LoRA 映射时无副作用）；
   - **styleOverlay 注入统一**：批量路径（generate-all 内 `script.artDirection?.overlay` 拼 prompt 处，搜索 `Project art direction style overlay`）改为从 resolver 取 `effective.styleOverlay`；单张路径 shot/main 若请求 prompt 中尚未包含该 overlay 语句，也在服务端以相同格式追加（幂等：已含则不重复追加——用 overlay 原文做包含判断即可）。
3. character / threeView / identity / upscale 路径**零改动**。

### A2. 参数快照扩为完整生效值（`buildShotGenerationSnapshot`）

CC 已落的 `buildShotGenerationSnapshot(projectId, seed)`（搜索函数名）扩为：

```jsonc
{
  "storyVersion": n, "styleContractVersion": n, "basedOnStoryVersion": n, "seed": n|null,
  "contractLocked": bool,
  "effective": { "storyboardPresetId": "...", "styleOverlay": "...", "width": n, "height": n, "loraStrength": n }
}
```

内部改用 `resolveEffectiveStyleContract`（同样 try/catch，失败时 effective 各字段落回 null/现状），`styleContractVersion` 直接取 resolver 返回的 version。retry 路径沿用原任务快照的行为**不变**。

### A3. 批量服务端闸门（`/api/comfyui/shots/generate-all`）

1. **`confirmed === true` 分支在创建任何 batch/task 行之前**：查该项目契约状态（用模块导出的 `isStyleContractInitialized` + `missingStyleContractFields`，或等价逻辑）：
   非 `locked===true && missing.length===0` → **`409 { error, code:'STYLE_CONTRACT_NOT_LOCKED', missing:[...], locked:bool }`，零副作用**（不写 batch 表、不写 task 行）；
2. preflight（非 confirmed）响应的 `preflight` 对象内**追加** `styleContract: { ready, locked, missing }` 字段，供前端在确认弹窗前拦截；
3. **单张生成不设闸门**（裁决：单张试跑允许"已保存但未锁定"的契约生效值）。

### A4. 旧入口保护（契约为唯一真相源的后端封口）

契约已初始化（`isStyleContractInitialized(project)`）时：

1. `PUT /api/generated-scripts/:id/comfyui-preferences`：落库前强制 `preferences.shotPresetId = project.styleContract.storyboardPresetId`（其余四个 preset 字段照常可改），响应返回实际落库值；
2. `PUT /api/generated-scripts/:id`（搜索 `const { newShots, newCharacters, title` 定位）：`artDirection` 分支落库前强制 `artDirection.overlay = project.styleContract.styleOverlay`（保留 body 里的 analysis 等其余子字段）。该 handler 为字段白名单式、`styleContract` 本就不可经它覆盖——**保持白名单，禁止顺手加字段**。
3. 未初始化时两个入口行为完全不变（旧项目零影响）。

---

## B. 前端（App.tsx 热区 —— 本次放权，改动限于下列四个区域）

通用规则：沿用现有暗色工作台样式与密度；不引新依赖；组件签名不写 `JSX.Element`；`index.css` 仅允许为五区标题/折叠新增 class，不改既有规则。

### B1. ② 风格设定步骤（`creativeStep === 1` 块，搜索 `上传风格参考图` 定位）

1. 挂载 `StyleContractPanel`（`projectId={String(generatedScript.id)}`；无 generatedScript 的草稿态维持现状不挂）；
2. **收编 overlay 旧编辑面**：该块内现有的 overlay `<textarea>`（`value={generatedScript?.artDirection?.overlay ...}` + `saveArtDirection` onBlur）**移除**，其职责并入 StyleContractPanel；
3. **保留"上传风格参考图"提取功能**，但改接契约：`handleAnalyzeArtDirection` 成功提取 overlay 后不再调 `saveArtDirection`，改为 `PUT /api/generated-scripts/:id/style-contract`（读现契约、仅替换 styleOverlay 后整体提交；**收到 409 CONTRACT_LOCKED 时提示"契约已锁定，请先解锁"**）；成功后让 StyleContractPanel 重取（最简单：给 Panel 加 `key={styleContractRefreshNonce}` 重挂）；
4. 草稿态（无 generatedScript）的 `creativeDraft.artDirection` 流程不变。

### B2. 第二处 overlay 编辑面（分镜步骤内，搜索 `返回风格设定` 附近的 overlay textarea）

整块移除，替换为一行说明 +「查看风格契约」按钮（点击回跳 `setCreativeStep(1)`）。风格在分镜阶段的展示由检查器区③承担（B3）。

### B3. 检查器五区重组（Column 3，搜索 `检查器 / INSPECTOR` 定位）

重组为五个带标题的区块（沿用 `inspector-group` 视觉；每区可折叠 `<details>`，默认展开 ①②④，③⑤ 默认收起）：

| 区 | 内容 | 来源 |
|---|---|---|
| ① 镜头意图 | shot 的 timestamp/description/emotion 只读摘要 | 现有 shot 数据，新渲染 |
| ② 结构参数 | 现 `StoryboardInspector` 全部内容（运镜/景别视角/人物位置/时长/提示词预览）+ **`CameraDerivePanel` 移入本区尾部的「机位工具」`<details>`（默认收起）** | 移动现有两组件 |
| ③ 项目风格契约 | `StyleContractReadonly`（`projectId`） | WP-G 组件 |
| ④ 当前分镜可调 | 「ComfyUI 高级调整」入口按钮移入此区（自中央列原位置迁移，行为不变） | 移动现有按钮 |
| ⑤ 生成版本历史 | `ShotVersionPanel` **自中央列（分镜画面 tab 下方）整体迁入**，props 原样 | 移动现有组件 |

注意：`CameraDerivePanel` 不再渲染于检查器顶部（原位置移除）；中央列移走 ShotVersionPanel 与高级调整按钮后注意布局不留空洞；`StoryboardInspector` 组件本体**不改**（只是包进区②）。

### B4. ComfyUI 高级调整模态的契约收敛（搜索 `handleOpenComfyParams` 与模态渲染处）

仅当 `targetType==='shot' && viewType==='main'` 且契约已初始化（GET style-contract 的 `initialized`，打开模态时顺带取一次）：

- `model`、`width`、`height`、`negativePrompt` 四项**置灰只读**，显示契约生效值 + 角注"由项目风格契约控制"；
- `prompt`、`seed/seedMode`、`sourceImageUrl` 保持可编辑（结构参数）；
- 未初始化或 character 目标：模态行为完全不变。

### B5. 批量闸门前端配合（`handleBatchGenerate`，搜索函数名）

1. preflight 响应若含 `preflight.styleContract` 且 `!ready`：在确认弹窗前直接 `alert` 说明（列 missing 与 locked 状态）+ `setCreativeStep(1)` 跳风格设定，**不发 confirmed 请求**；
2. confirmed 请求收到 `409 STYLE_CONTRACT_NOT_LOCKED` 同样处理（服务端是权威，前端拦截只是体验）。

### B6. 明确不动

- characterMaster / threeView 两个 preset 选择器（`saveProjectPresetField` 两处调用）**保留原样**；
- 顺手清理：`saveProjectPreset`（shotPresetId 的整包保存函数，现已无调用方）确认死代码后删除；`templatePresetId`（workflow 模板下载选择器）是另一功能，**别动**。

---

## C. 测试与验收

1. **后端**：核心 server.ts 无独立测试基建，验收走 **db 副本 curl 证据**（照 WP-G 模式，绝不碰正式 db.sqlite）：
   - 契约未锁定 → `generate-all confirmed=true` 返 409 + code + missing，**并证明 comfyui_tasks/comfyui_shot_batches 零新增**（前后 COUNT）；
   - 契约锁定后 → 同请求通过闸门（走到原有 preflight/enqueue 逻辑）；
   - 单张 shot/main enqueue（ComfyUI 可离线，任务落 pending/failed 均可）→ 读该任务行 `generationSnapshotJson`，证明含完整 effective 契约值且与锁定契约一致；宽高被契约接管（请求给 512 也落契约值）；
   - `PUT comfyui-preferences` 尝试改 shotPresetId → 落库仍为契约值；`PUT /api/generated-scripts/:id` 带异 overlay 的 artDirection → 落库 overlay 仍为契约值、analysis 保留；
   - 契约未初始化的旧项目：上述接口行为与基线一致（各取一例）。
2. **前端**：`npm run lint` + `npm run build` 过；可用性四项（键盘可达/点击目标/对比度/缩放）自查；
3. **真机联调申请**：完成后通知 CC，浏览器验收由 CC 执行（五区渲染、契约只读区、锁定/解锁流、批量闸门提示、模态置灰）——**自报截图不作数，铁律 #2 不变**；
4. 证据文档：`docs/ui-redesign/tasks/evidence/p3-wiring-acceptance.md`（curl 全流程 + 测试/lint/build 输出 + 改动点自查清单）。

## D. 边界（违反即返工）

- 允许触碰：`server.ts`（限 A1–A4 指定点）、`src/App.tsx`（限 B1–B6 指定区域）、`src/index.css`（限五区新增 class）、`src/components/StyleContractPanel.tsx`（若 B1 上传接线需给自家组件加可选 prop）；
- 禁止触碰：`router.ts`、`main.tsx`、`server/modules/*`（style-contract 也含——resolver 签名如需变更，先来找 CC 议）、其他组件文件；
- App.tsx 范围外区域（素材库/分析页/系统抽屉/交付面板等）**一行不动**；发现顺手可修的问题记进证据文档"发现但未动"清单；
- 不建表、不加依赖、正式 db.sqlite 零污染；
- 提交前缀 `feat(p3-wiring): ...`，可拆多个提交（建议 A 后端一个、B 前端一到两个），不 push，完成后通知 CC 逐行 review + 浏览器验收。
