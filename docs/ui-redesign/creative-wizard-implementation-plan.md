# 创意生成向导 UI 改版 — 实施计划（交付 Codex 执行）

> 目标：把三张设计稿（步骤1 风格设定 / 步骤3 分镜生成工作台 / 步骤4 导出）落地到现有 React 应用的「创意生成」向导。
> 本文档自包含：包含现状代码地图、逐阶段任务、复用的状态与函数名、验收标准。执行前请通读。

---

## 0. 项目现状（必读）

- 仓库：`C:\Users\Owner\Documents\GitHub\-`（Vite 6 + React 19 + Tailwind v4 CSS-first + Express 后端）
- 基线 commit：`5d5d324 feat(ui): migrate ui-redesign design system into the workbench app`
- 前端全部在 **单文件组件** [src/App.tsx](../../src/App.tsx)（约 7000 行，`export default function App()`）。改动时**用字符串锚点定位，不要依赖行号**。
- 设计 token 已就位：[src/index.css](../../src/index.css) 用 `@theme` 把 `slate-*` 重映射为 surface 阶梯（`#0b0d14` 起）、`blue-*` 重映射为 indigo 品牌色（`#6366f1`）。**新 JSX 直接写 `bg-slate-900`/`text-blue-400` 等即可得到新设计的颜色，不要硬编码 hex**。
- 已有组件类（index.css `@layer components`）：`.maintabs`、`.rstat-card`、`.char-grid`/`.char-card`、`.comfy-pill`/`.comfy-pop`、`.rhythm-bar`、`.admin-shell`/`.admin-layout`/`.admin-navigation`/`.admin-workspace`/`.admin-inspector`。
- 参考设计稿（静态 HTML，可在浏览器打开对照）：[ui-redesign/creative.html](../../ui-redesign/creative.html)（向导四步）、[ui-redesign/index.html](../../ui-redesign/index.html)（分析主界面，已迁移完成，本次不动）。

### 运行与验证
```bash
npx tsc --noEmit        # 必须零错误（等同 npm run lint）
npm run dev             # vite :3000，vite 插件自动 spawn Express :3001
```
⚠️ **PORT 坑**：Express 读 `process.env.PORT || 3001`。任何注入 `PORT` 的启动器都会让 Express 抢占 3000。`.claude/launch.json` 已用 `cmd /c "set PORT=&& npm run dev"` 规避。不要改 `package.json` 的 dev script。

### 现状布局（迁移后）
- 顶栏：logo + 标题 + 文件名 chip + `分析就绪` pill + **ComfyUI 状态 pill（`.comfy-pill`，含弹层：平台选择/启动/停止/打开模板/项目预设）** + 导出 JSON。
- `activeTab !== "generator"`：三栏 = 素材库侧栏 / 主区（`mainTabsBar` + 面板）/ 右栏统计+上下文。
- `activeTab === "generator"`：主区+右栏合并为全宽向导（`.admin-navigation + .admin-inspector` 自动跨列），顶部仍是 `mainTabsBar`。
- 向导现有四步由 `creativeStep`（1-4）控制，已有步骤面包屑（锚点：`创作向导面包屑`）。

---

## 1. 设计目标（三张设计稿的要求）

进入创意生成后，整个应用壳变为「项目工作台」模式：

1. **左侧栏**：不再显示素材库，改为窄导航（分镜脉络/人物画像/叙事与亮点/创意生成+`NEW` 徽标，图标+文字，当前项高亮），底部固定显示来源视频标题。
2. **顶栏**：logo + 面包屑「`{来源视频标题}` / `{项目标题}`」+ 右侧 `分析完成` pill、`ComfyUI 未连接` pill（复用现有 comfy-pill）、`← 返回分镜列表` 按钮（回 shots tab）。
3. **步骤条**（顶栏下方独立一行）：四步，每步显示状态徽标（✓已完成 绿 / 数字+进行中 indigo / 数字+步骤N 灰），右侧 `← 上一步` `下一步 →`（步骤4 为 `导出全部 ↓`）。
4. **步骤1 风格设定**：主列（全局艺术方向 textarea + 建议 hint / 风格模板 6 卡网格，点选自动填充 textarea / 情绪基调 chips 多选 / 模型选择单选列表）+ 右侧 `当前配置` 摘要卡（风格预览、情绪 tags、服务状态 LLM/ComfyUI）。
5. **步骤3 分镜生成工作台**（本次最大改动）：
   - 顶条：角色头像条（缺资产者带 ⚠ 徽标）+ `LLM 脚本 就绪 / ComfyUI 未连接` 状态块 + `▶ 批量生成脚本` 按钮。
   - 三栏：**左** 分镜列表（进度条「脚本 x/N · 图像 y/N」、编号+时间码+标题+状态图标、底部批量操作）；**中** 当前分镜详情卡（编号、时间码、标题、情绪 tag、角色绑定 chips + 进入资产中心、AI 生成脚本块[复制/全屏编辑/立即优化/重新生成/手动编辑/复制文本]、分镜图像区[未连接占位+去连接+跳过此镜图像；有图时高级调整/导入结果/图生视频]、`← 上一镜` `下一镜 →`、`✓ 确认脚本`）；**右** 上下文（Art Direction 摘要+编辑、当前分镜角色资产状态卡[✓Avatar ✓PuLID ✓参考图 / ⚠缺参考图+修复]、+绑定角色、输出设置[脚本语言/自动生成全部/生成后自动优化]）。
6. **步骤4 导出**：左侧故事板缩略网格（编号+生成图或占位+标题+一句描述）；右侧：状态 banner（`剧本与分镜故事板已生成 · 已生成 x/N 张图像`）、缺图警告条、四格统计（分镜总数/绑定角色/生成图像/脚本字数）、导出偏好配置（LoRA 一致性权重/高清防伪水印/原片分析 metadata 三个 toggle + 画面纵横比 select）、导出格式列表（Markdown 剧本/故事板 PDF/打包 ZIP）、`← 上一步` `⬇ 全部导出`。

---

## 2. 现状代码地图（用这些字符串 grep 定位）

### 状态（都在 App() 顶部，`useState` 区）
| 名称 | 用途 |
|---|---|
| `activeTab` / `setActiveTab` | `"shots" \| "characters" \| "narrative" \| "generator"` |
| `creativeStep` / `setCreativeStep` | 向导步骤 1-4 |
| `creativeDraft` / `setCreativeDraft` | 未建项目时的草稿 `{ artDirection?: { overlay, analysis } }` |
| `generatedScript` / `setGeneratedScript` | 当前打开的创意项目（`GeneratedScriptRecord`，含 `newShots`/`newCharacters`/`newNarrative`/`artDirection`/`topic`） |
| `generatedScripts` / `setGeneratedScripts` | 历史剧本列表 |
| `selectedRecord` | 当前来源视频（null = 演示样本） |
| `shotImages` | `Record<timestamp, imageUrl>` 分镜图缓存 |
| `imagePlatform` / `setImagePlatform` | `'comfyui' \| 'pollinations' \| 'kling'` |
| `comfyRuntime` | `{ state: 'stopped'\|'starting'\|'running'\|'external'\|'stopping'\|'error', pid, managed, lastError }` |
| `isComfyConnected` | 派生：running 或 external |
| `regenerateMode`, `isQueueingBatch`, `hasActiveBatch`, `currentBatchId`, `batchTasks`, `succeededCount/pendingCount/failedCount/skippedCount/totalCount`, `processingTask` | 批量生图状态 |
| `generatingShotIndex` | 单镜生成中的行号 |
| `shotCharacterModal` / `shotCharacterFeedback` | 分镜角色绑定弹窗状态 |
| `activeDrawerChar` / `setActiveDrawerChar` | 角色资产抽屉（含三视图槽位、母版生成、导入） |
| `selectedCharacter` | 角色档案弹窗 |
| `artDirectionBusy` / `artDirectionMessage` | 风格提取状态 |
| `workflowPresets` / `storyboardPresets` / `selectedStoryboardPreset` / `comfyProjectPreferences` | 模型/工作流预设 |
| `showComfyPop` | 顶栏 comfy 弹层 |

### 函数（复用，不要重写）
| 名称 | 用途 |
|---|---|
| `handleGenerateScript()` | 生成新剧本（POST `/api/generate-script`） |
| `handleGenerateShotImage(shot, idx, scriptOverride?)` | 单镜生图 |
| `handleBatchGenerate()` / `handleStopBatchGeneration()` / `handleExportBatchReport()` | 批量生图/停止/验收报告 |
| `handleBindShotCharacter(idx)` + `handleSaveShotCharacters()` + `handleModalCharacterToggle()` | 分镜角色绑定（PUT `/api/generated-scripts/:id/shots/:shotId/matched-characters`） |
| `handleOpenAdvanced(task)` | 打开 ComfyUI 高级调整 |
| `handleStartComfy()` / `handleStopComfy()` | 启停 ComfyUI |
| `saveArtDirection(overlay)` | PUT `/api/generated-scripts/:id` 持久化 `artDirection` |
| `handleAnalyzeArtDirection(file)` | POST `/api/analyze-image-prompt`（`styleOnly=true`）从参考图提取风格 |
| `handleGenerateVideoKling(shot, shotIdx)` | 图生视频 |
| `getShotTask(shotId)` / `getCharacterTask(charId, view)` / `renderComfyTaskOverlay(task)` | ComfyUI 任务状态/角标 |
| `renderCharacterAvatar(char)` / `characterAssetStatus(char)` | 头像渲染 / 资产完备度（hasAvatar, viewCount, hasReference） |
| `handleRowDragStart/Over/Drop` | 分镜拖拽排序（新列表要保留此能力） |
| `mainTabsBar` | 主导航 JSX 变量（generator 分支也渲染它） |

### JSX 锚点（grep 定位用）
- `创作向导面包屑` — 现有步骤条
- `{creativeStep === 1 && (` / `Project Art Direction - 风格分析与 Style Guide 编辑区`
- `{creativeStep === 2 && (` — 故事概览 + 角色卡横滚
- `{creativeStep === 3 && (` — Art Direction 摘要 + 分镜大表格（`BOTTOM SECTION: Shots Table`）
- `{creativeStep === 4 && (` / `STEP 4: EXPORT CONSOLE` — 目前导出按钮多为 `alert()` 占位
- `Column 3: 右栏（统计 + 上下文）` — generator 全宽容器所在 section
- `Column 2: 主功能区` — 非 generator 时的主区

---

## 3. 总体架构决策（已敲定，不要偏离）

1. **不做独立页面**：向导仍在 SPA 内，`activeTab === "generator"` 时接管。设计稿的「独立页」观感通过改壳实现。
2. **壳模式切换**：新增派生量 `const wizardMode = activeTab === "generator";`
   - `wizardMode` 时左侧 `admin-navigation` 渲染**窄导航**（四个功能项，点击即 `setActiveTab`；底部显示 `selectedRecord?.title || '蒸汽飞空艇与少女 (演示样本)'`），素材库/历史剧本列表隐藏。
   - 顶栏在 `wizardMode` 时：文件名 chip 换成面包屑 `{来源} / {generatedScript?.newTitle || '新建创意'}`；新增 `← 返回分镜列表` ghost 按钮（`onClick={() => setActiveTab("shots")}`）。
3. **步骤条重做**：替换现有面包屑为设计稿样式（状态徽标 + 右侧上一步/下一步）。**步骤门禁**：无 `generatedScript` 时步骤 2-4 禁用（灰显，title 提示「先在步骤1生成剧本」）。
4. **一切复用现有 handler**，只重排 UI。任何设计稿元素若无对应后端能力，按第 4-7 节的「降级方案」处理，禁止造假数据。
5. **不改 server.ts**（其工作区改动属于另一条开发线）。唯一例外：第 6 节的 `scriptConfirmed` 若需要持久化，走已有的 `PUT /api/generated-scripts/:id`（body 传 `newShots`，该接口已支持）。
6. 全程 `npx tsc --noEmit` 零错误；Chinese UI 文案；新 CSS 一律进 `index.css` 的 `@layer components`，色值用现有 token/Tailwind 类。

---

## 4. Phase 1 — 壳与步骤条（预计改动最小，先做）

**文件**：`src/App.tsx`、`src/index.css`

1. `wizardMode` 派生量（见上）。
2. 侧栏：在 `admin-navigation` 内容最外层加条件——`wizardMode` 渲染新窄导航（复用 `mainTabsBar` 的四项数据，样式参考设计稿：图标 + 文字 + 当前项 `bg-slate-800 rounded-lg`，创意生成项带 `NEW` 徽标 `bg-blue-500 text-white text-[9px] rounded-full px-1.5`）；否则渲染现有素材库内容（**原内容不动，包一层条件即可**）。图标用已 import 的 lucide（`Film`/`Users`/`Share2`/`Sparkles`），不够再补 import。
3. 顶栏面包屑与 `返回分镜列表`（仅 `wizardMode`）。
4. 步骤条：改造 `创作向导面包屑` 区块——
   - 数据：`[{num:1,label:'风格设定'},{num:2,label:'角色配置'},{num:3,label:'分镜生成'},{num:4,label:'导出'}]`
   - 每步：圆形徽标（完成=绿底✓，当前=indigo 底数字，未到=灰圈数字）+ 两行文字（小字状态「已完成/进行中/步骤 N」+ label），当前步下方 2px indigo 下划线。
   - 右侧：`← 上一步`（step>1 时可用）/ `下一步 →`（step<4）/ step 4 时换 `导出全部 ↓`（触发 Phase 4 的全部导出）。
   - 移除旧的 `⚡ 一键进入高级工作台` 按钮（其行为=跳步骤3，新步骤条本身可点击跳转，冗余）。
5. `wizardMode` 且无 `generatedScript` 时仍显示步骤条（步骤1 可用，2-4 禁用）。

**验收**：四个 tab 来回切换正常；wizard 内左导航可跳回其他 tab；tsc 零错误；非 wizard 视图与基线截图一致。

---

## 5. Phase 2 — 步骤1 风格设定

**布局**：`grid grid-cols-[1fr_280px] gap-6`（<1100px 时右栏下移）。

主列（自上而下）：
1. **全局艺术方向**：复用现有 Art Direction 区块（textarea + `上传风格参考图` + `handleAnalyzeArtDirection`），按设计稿改标题为「全局艺术方向」，下加 hint 行「💡 建议参考：基础风格 + 光线特征 + 材质感 + 色调偏向」。
2. **风格模板**：6 卡网格（新增本地常量数组）：
   ```ts
   const STYLE_TEMPLATES = [
     { id:'cyberpunk-anime', name:'赛博朋克动画', emoji:'🎨', overlay:'Stylized animation art, bold outlines, warm sunset backlighting, cold shadow tones, expressive brushwork, concept art aesthetic, hand-drawn texture, cinematic color grading' },
     { id:'cinematic-real',  name:'电影写实',     emoji:'📷', overlay:'Photorealistic cinematic still, shallow depth of field, natural volumetric lighting, filmic color grading, 35mm grain' },
     { id:'ink-wash',        name:'水墨国风',     emoji:'🌊', overlay:'Chinese ink wash painting style, flowing brush strokes, negative space composition, muted earth tones, rice paper texture' },
     { id:'hand-drawn',      name:'手绘插画',     emoji:'🌿', overlay:'Hand-drawn illustration, soft watercolor washes, visible pencil linework, warm storybook palette' },
     { id:'film-noir',       name:'黑色电影',     emoji:'🎭', overlay:'Film noir style, high contrast chiaroscuro lighting, deep shadows, monochrome with selective color, 1940s atmosphere' },
     { id:'custom',          name:'自定义',       emoji:'⚙️', overlay:'' },
   ];
   ```
   点选卡片：高亮 + 若非 custom 则把 overlay 写入 Art Direction textarea（走现有 onChange 路径：有项目 `setGeneratedScript` + onBlur `saveArtDirection`；无项目 `setCreativeDraft`）。选中态新增 state `styleTemplateId`（`useState<string>('custom')`）。
3. **情绪基调**：chips 多选，新增 state `moodTones: string[]`。候选：`['震撼史诗','神秘悬疑','温情治愈','轻松幽默','黑暗压抑','热血燃情','浪漫唯美','末日惊悚']`。生成剧本时并入请求：找到 `handleGenerateScript` 内 POST `/api/generate-script` 的 body，把 `preferences` 扩展为 `{ ...现有, moodTones }`（后端 `preferences` 是透传对象，无需改 server）。
4. **模型选择**：复用现有「模型 / 工作流预设」区块（锚点 `模型 / 工作流预设`），重排为设计稿的单选列表样式（radio 圆点 + 名称 + 描述 + 右侧 tag），数据仍来自 `storyboardPresets`，选择仍走 `saveStoryboardPreset(presetId)`。不可用预设 disabled + 原因文案。

右栏 **当前配置**：风格模板预览块（选中模板的 emoji+渐变底）、overlay 前 60 字、情绪 tags、分隔线、服务状态两行：`LLM 脚本生成`（`GEMINI_API_KEY` 前端无法探测——用固定「就绪」+ 生成失败时才在表单处报错，照旧）与 `ComfyUI 图像生成`（`isComfyConnected ? '就绪' : '未连接'`，未连接时点击打开顶栏 comfy 弹层：`setShowComfyPop(true)`）。

底部 CTA：`下一步：角色配置 →`（有 `generatedScript` 时 `setCreativeStep(2)`；无项目时该按钮换成滚动到下方现有「AI 模板创意生成器」表单的提示——表单区块保留在步骤1 内，锚点 `Script writer Form`）。

**验收**：选模板即填充 textarea 并（有项目时）失焦保存成功；chips 状态保持；预设选择照常持久化；无项目时步骤1 仍能走通「生成剧本」流程。

---

## 6. Phase 3 — 步骤3 分镜生成工作台（核心）

> 现状是一张全宽可编辑大表格。目标改为「列表-详情-上下文」三栏。**表格的所有能力必须在新 UI 中保留**：行内编辑（运镜/构图/情绪/描述）、拖拽排序、单镜生图、优化 prompt、高级调整/导入、Kling 图生视频、角色绑定、批量生图控制。

**新增 state**：
```ts
const [activeWizardShotIdx, setActiveWizardShotIdx] = useState(0); // 当前选中镜
```
`generatedScript` 切换时重置为 0。

**布局**：`creativeStep === 3` 分支重写为：
```
<顶条 charStrip + 服务状态 + 批量按钮>
<div className="wizard-shot-grid">   // grid-template-columns: 240px minmax(0,1fr) 260px; gap 0; 高度撑满，各列独立滚动
  <左列/> <中列/> <右列/>
</div>
```
CSS 类 `wizard-shot-grid` 进 index.css（含 <1200px 退化：右列并入中列下方）。

**顶条**：
- 角色条：`generatedScript.newCharacters` 头像（`renderCharacterAvatar`），缺 avatar 者右上 ⚠ 徽标（`characterAssetStatus(char).hasAvatar`），点击 `setActiveDrawerChar(char)`。
- 状态块：`LLM 脚本 就绪` + `ComfyUI {isComfyConnected?'已连接':'未连接'}`。
- `▶ 批量生成脚本` → 保留现有批量生图控制组（`regenerateMode` select + `handleBatchGenerate` + 停止 + 批量进度 chips + 验收报告按钮），整体移到这里（原锚点 `一键生成所有分镜` 一带整块搬迁，按钮文案不改）。`生成动态分镜板` 按钮也移到此条右端。

**左列 分镜列表**：
- 头部：标题「分镜列表」+ 进度条（`脚本 {scriptConfirmedCount}/{N} · 图像 {imageCount}/{N}`；`imageCount = newShots.filter(s => shotImages[s.timestamp] || s.generatedImageUrl || s.imageUrl).length`）。
- 列表项：编号、`shot.timestamp.split(' - ')[0]`、`shot.movement` 截断、右侧状态图标（有图=绿✓；`getShotTask(shot.id)` processing=旋转 loader；失败=红 ✗；无=灰圈）。选中项 `bg-slate-800 + inset 2px indigo 左边框`。点击 `setActiveWizardShotIdx(idx)`。
- 保留拖拽：项上挂现有 `handleRowDragStart/Over/Drop`（注意排序后同步修正 `activeWizardShotIdx`：跟随被选 shot 的新位置）。
- 底部批量操作条可省（顶条已有）。

**中列 分镜详情**（`const shot = generatedScript.newShots[activeWizardShotIdx]`，空保护）：
1. 头部：大编号徽标 + 时间码 + `shot.movement`（inline 可编辑，沿用现有行内编辑逻辑/保存路径——现表格里 movement/composition/emotion/description 的编辑最终都落在 `setGeneratedScript` + PUT，把这些编辑控件迁过来）+ 情绪 tag（`shot.emotion`）。
2. **角色绑定**：chips = `newCharacters.filter(c => shot.matchedCharacterIds?.includes(String(c.id)))`，带 ✓；`+` chip 打开 `handleBindShotCharacter(activeWizardShotIdx)`；`进入资产中心 ↗` = `setActiveDrawerChar(第一个绑定角色 || newCharacters[0])`。绑定弹窗与反馈条（`shotCharacterModal`/`shotCharacterFeedback`）原样保留。
3. **AI 生成脚本块**：`shot.description` textarea（手动编辑=聚焦它）；按钮行：`复制`（clipboard description）、`立即优化`（现有优化 prompt 动作，锚点搜 `optimize-shot`/现表格的优化按钮 handler）、`重新生成`（同优化重跑）、`复制文本`。全屏编辑可暂缓（P2 优先级，做成放大 modal 也行）。
4. **分镜图像区**：
   - `imagePlatform==='comfyui' && !isComfyConnected`：占位（图标 + 「ComfyUI 未连接，图像生成不可用」）+ 底条 `图像服务未连接 · 去连接 ↗`（`setShowComfyPop(true)`）+ `跳过此镜图像`（仅本地标记：`shot.videoStatus` 不动，用新 local state `skippedShots: Set<string>` 即可，影响步骤4 统计）。
   - 已连接无图：`生成本镜` 按钮 → `handleGenerateShotImage(shot, activeWizardShotIdx)`；生成中显示 `renderComfyTaskOverlay(getShotTask(shot.id))`。
   - 有图：展示 `shotImages[shot.timestamp] || shot.generatedImageUrl || shot.imageUrl`（点击进现有 Lightbox，锚点 `LIGHTBOX MODAL` 的打开 setter）+ 操作：`重新生成` / `高级调整`（`handleOpenAdvanced(getShotTask(shot.id))`）/ `图生视频`（`handleGenerateVideoKling(shot, activeWizardShotIdx)`，保留现有视频状态展示）。
5. 底部：`← 上一镜` `下一镜 →`（clamp 边界）；右侧 `✓ 确认脚本`：给 shot 打标记。**实现**：`Shot` 类型加 `scriptConfirmed?: boolean`（改 [src/types.ts](../../src/types.ts)），点击后 `setGeneratedScript` 更新该镜 + `PUT /api/generated-scripts/:id`（body `{ newShots }`，接口已存在且透传保存）。已确认时按钮变绿「已确认 ✓」。

**右列 上下文**：
1. **全局风格**卡：`generatedScript.artDirection?.overlay` 前若干字 + `编辑` 按钮（打开一个小 textarea 弹层或直接 `setCreativeStep(1)`，选后者，简单）。
2. **当前分镜角色**：绑定角色的状态卡——`✓ Avatar`（hasAvatar）、`✓ PuLID`（`char.sourceTaskId || char.hasReference`）、`✓/⚠ 参考图`（`hasReference`；⚠ 时 `修复` = `setActiveDrawerChar(char)`）；`×` 移除绑定 = 调 `handleShotCharacterToggle(activeWizardShotIdx, charId)`。底部 `+ 绑定角色`。
3. **输出设置**：`脚本语言` select（中文/English/双语，新 state `scriptLanguage`，并入 `handleGenerateScript` 的 `preferences.language`）；`自动生成全部` toggle（开=脚本生成完成后自动触发 `handleBatchGenerate()`，仅当 `isComfyConnected`）；`生成后自动优化` toggle（新 state，暂只存不接行为，UI 注明「即将上线」除非现有代码已有对应逻辑）。

**移除**：旧的大表格区块（`BOTTOM SECTION: Shots Table` 整块）——先确认其中每个功能都已在新三栏中有落点再删。

**验收**：选镜/编辑/绑定/生图/优化/高级调整/图生视频/批量/拖拽全部可用；断开 ComfyUI 时占位与「去连接」生效；确认脚本后左列进度条计数变化并在刷新后保持（持久化成功）。

---

## 7. Phase 4 — 步骤4 导出

**布局**：`grid grid-cols-[1fr_320px] gap-6`。

左：**故事板缩略预览 ({N} 分镜)** + 右上 `✓ {imageCount} 张已生成` tag；网格 `repeat(auto-fill,minmax(200px,1fr))`，卡片=编号角标 + 图（无图用渐变占位+🎬）+ `shot.movement` + `shot.description` 一行截断。点击卡片 → `setCreativeStep(3)` 并 `setActiveWizardShotIdx(idx)`。

右列：
1. Banner：🎬 `剧本与分镜故事板已生成` / `{newTitle} · 已生成 {imageCount}/{N} 张图像`。
2. 缺图警告（`imageCount < N` 时）：`⚠ {N-imageCount} 个分镜未生成图像，导出物将使用占位图`。
3. 统计四格：分镜总数 N / 绑定角色数（`newCharacters.length`）/ 生成图像 imageCount / 脚本字数（`newShots.reduce((a,s)=>a+(s.description||'').length,0)`，显示 `3.2k` 格式）。
4. **导出偏好配置**：三个 toggle + 纵横比 select——新 state `exportPrefs`（`{ includeLora:true, watermark:false, includeMetadata:true, aspect:'16:9' }`），仅写入导出产物 metadata，不接后端。
5. **导出格式**：
   - `Markdown 格式剧本`：**本次必须实现**。客户端拼装：标题、narrative 三段、角色表、分镜表（编号/时间码/运镜/构图/情绪/描述/图像 URL），`Blob` 下载 `.md`。
   - `故事板 PDF 报告`、`打包 ZIP 故事板`：无后端支持，按钮保留但 disabled + title「即将上线」。**不要用 alert 假装成功**（现状的 `alert('全部故事板与参数已成功导出完毕！')` 一并删除）。
   - 已有的 `导出 JSON` 能力（顶栏）不动；步骤4 可加一项 `JSON 分镜数据` 复用 `handleDownloadJson` 同构逻辑（对 generatedScript 拼装）。
6. `← 上一步` + `⬇ 全部导出`（= 依次触发 Markdown + JSON 下载）。

**验收**：Markdown 文件内容完整可读；缺图统计与警告随实际图像数变化；disabled 项不误导。

---

## 8. Phase 5 — 回归与提交

1. `npx tsc --noEmit` 零错误。
2. 手测清单：
   - 非 wizard 三个 tab 与基线一致（截图对比）。
   - 演示样本（无 `selectedRecord`）与真实项目两条路径都走一遍向导四步。
   - 侧栏历史剧本点击 → 直接进入向导且步骤条状态正确。
   - ComfyUI 未连接/已连接两种状态下步骤3 的图像区表现正确。
   - 刷新页面后：确认脚本标记、artDirection、预设选择均保持。
3. 提交拆分为 4 个 commit（Phase 1-4 各一个），message 用 `feat(ui-wizard): ...` 前缀，结尾加 `Co-Authored-By` 按仓库惯例。**不要把 server.ts / .env.example / scripts/ 下的既有未提交改动带进 commit。**

---

## 9. 风险与禁区

- **App.tsx 是单一巨型组件**：不要做「顺手重构/拆文件」，本次只做计划内改动；定位一律用本文锚点字符串。
- **不要动** 顶栏 comfy-pill、`mainTabsBar`、非 wizard 三个 tab 面板、角色抽屉（`CHARACTER DETAILS SLIDING DRAWER`）、各 Modal 的内部逻辑——只允许从新 UI 调用它们。
- 删除旧步骤3 大表格前，逐项核对能力清单（第 6 节开头粗体句）。
- Tailwind v4：`slate-750`/`slate-850` 是本项目自定义色阶，可直接用；不要引入外部字体/CDN。
- 所有新增文案中文；代码注释仅在表达约束时添加。
