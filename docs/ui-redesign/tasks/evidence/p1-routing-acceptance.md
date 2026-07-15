# P1 路由化拆页验收证据（WP-D 第一批 · Claude Code · 2026-07-14）

方案依据：`docs/ui-redesign/workflow-redesign-2026-07-14.md` §三/§七 P1。
分支：`feat/p1-routing`（基线 `e1e5873`）。
验证方式：`npm run lint`（tsc --noEmit）通过 + 本地 dev 真机 DOM 检查，控制台（error 级）零输出。

## 交付内容

### 1. Hash 路由（新增 `src/router.ts`）
`#/library`（默认）｜`#/analysis/demo`｜`#/analysis/:id`｜`#/studio`｜`#/studio/new`｜`#/studio/:id`。
URL 是页面/实体的唯一真相源：点击只改 hash，App 内单一"URL→状态"派发器统一落状态；
空 hash 归一化为 `#/library`。

### 2. 素材库首页（上传优先落地页）
- 无记录：整页居中大上传区 + 引导文案；有记录：上传区收窄 + **记录卡片网格**（标题/类型/标签/分镜数/日期/删除，点击进分析页）+ 搜索框。
- 竖屏短剧模式开关随上传区；**演示样本改为一行小入口**（"或先试用内置演示样本 →"），不再默认加载。
- 实测：`hasUpload/hasRecordsGrid/hasDemoEntry/hasGlobalNav = true`，旧三栏布局在首页不渲染。

### 3. 拉片工作台（`#/analysis/:id`）
- 顶部 tab 只剩分析三件套（创意生成从 tab 组移除），右侧新增主 CTA「以此为模板创作 →」→ `#/studio/new`。
- 实测 tabs = `[分镜脉络, 人物画像, 叙事与爽点, 以此为模板创作 →]`，标题徽标显示当前视频名。

### 4. 创意项目（`#/studio` 列表 + `#/studio/:id` 工作室）
- 列表页：项目卡片网格（标题/主题/分镜数/日期）+ 新建 + 空态引导回素材库。
- 项目直达：加载项目并进入创作向导；顶栏全局导航「素材库｜创意项目」随路由高亮。

### 5. 刷新恢复（P0 遗留的根治项）
- `#/studio/1783192733645` 硬刷新 → 直接恢复到《孤岛豪宅谋杀案》创意工作室（标题/步骤条在位）；
- `#/analysis/1783192167990` 硬刷新 → 直接恢复到 test a 拉片页。
- 上传分析完成自动跳 `#/analysis/:newId`；删除当前选中记录自动回 `#/library`；
  坏链接（记录/项目不存在）自动回退上级页面。

### 6. 视频生成 UI 下线（v2.1 语义：下线生成调用，保留资产入口）
- 向导中央 tab「动态视频」→「**视频资产**」只读：有 `videoUrl` 则播放器查看，无则占位说明；
  生成按钮、进度 overlay、检查器「视频生成服务商」下拉全部移除。
- 实测：`noGenVideoBtn/readOnlyNote/noProviderSelect = true`。后端视频 API 未动。

## 过程中发现并修复的既有 bug

`App.tsx` 原有 effect（监听 `selectedRecord`）在记录变化时无条件清空 `generatedScript`——
这会抹掉刚打开的创意项目（老交互下"从选中视频点历史剧本被弹回起始页"即此病根）。
已把"模板变更时重置生成器"职责移入路由派发器，该 effect 只保留播放器状态重置。

## 遗留（P1 第二批）

- 分析页左栏改分镜时间轴、右栏统计可折叠；
- 系统状态抽屉正式化（ComfyUI 弹层重组，JSON 导出移入项目导出步骤）；
- 视频资产归入"项目资产"区（当前以只读 tab 形态保留入口）；
- analysis 页 tab 状态进 URL query（当前刷新后回默认 tab）。
