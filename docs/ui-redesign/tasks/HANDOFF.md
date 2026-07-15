# UI 重设计 — 会话交接（2026-07-15）

> 新对话开场把本文件读一遍即可接续。协调人 = CC（Claude Code）；重活外包给 Codex/Antigravity。

## 现在在哪

- **主线分支**：`feature/camera-derive`，HEAD = `ef51af7`，工作区干净（只剩几个刻意未入库的根目录草稿 `*.txt`/`.patch`）。
- **已完成**：P0 止血 → P1 路由化 → P1b 布局 → P2a 故事编辑/定稿 → P2b 交付导出。**创作闭环全线打通**：故事编辑(版本化) → 分镜生成 → 评审/定稿 → 交付检查 → 双模式导出(PPTX 交付包 + 工具内审阅 + 打印即 PDF)。
- 五个外包工作包全部 review PASS 并合入：WP-B(shot-review)、WP-C(export-deck)、WP-E(story-version)、WP-F(delivery-ui)，加 CC 自做的 P0/P1/P1b 与各次接线。

## 权威文档（都在 `docs/ui-redesign/`）

- 方案 v2.1：`workflow-redesign-2026-07-14.md`
- 集成计划 + 12 项设计裁决 + 批次表 + 协作纪律：`tasks/integration-plan-2026-07-14.md`
- 各工作包契约：`tasks/codex-*.md`、`tasks/antigravity-*.md`
- 验收证据：`tasks/evidence/*.md`（每个工作包一份）
- CC 的持久记忆索引也有一条 `workflow-redesign-2026-07`，状态同步。

## 铁律（踩过坑固化的，务必守）

1. **主工作区永久归 CC**（前端热区 `src/App.tsx`/`index.css`/`router.ts`/`main.tsx` 独占）。外部 agent **强制 `git worktree add`**，禁止在主工作区切分支——违反过一次，CC 的提交落错分支，做过手术。
2. **视觉/交互验收以复核方(CC)为准**，agent 自报 PASS 不作数（Antigravity 自报 COM 渲染通过却没拦住画布越界，就是这条的由来）。
3. **合并只经集成分支**，CC 统一执行 + 回归(lint + 全量 node:test + 真机冒烟)。
4. 外包套路（已验证 5 次，省 CC 额度）：**Codex 写后端模块 + 独立前端组件文件；CC 只做 App.tsx 热区接线**。后端模块照抄 `server/modules/camera-derive/` 结构；server.ts 每包只许 1 行 import + 1 行 register。
5. 组件签名**别写显式 `JSX.Element`**（仓库没装 `@types/react`，会炸类型检查）。
6. 分镜存 SQLite `store` 表 `key='generated_scripts'` 的 JSON，**没有 shots 表，禁止建表**；新字段走 Shot/GeneratedScriptRecord 的可选 JSON 字段(旧数据零迁移)。

## 环境备忘

- dev 启动：Browser 工具 `preview_start {name:"dev"}`（走 `.claude/launch.json`）。vite 端口常被占会自动换，express 后端 = vite 端口 + 1。**绝不用 Bash 跑 dev server**。
- lint：`npm run lint`（= `tsc --noEmit`）。测试：`npx tsx --test <模块>/*.test.ts`（node:test，`:memory:` SQLite + mkdtemp 隔离）。
- 本机现已装 LibreOffice：PPTX 可 `soffice --headless --convert-to pdf` 渲染做视觉复核。

## 下一步该做什么（挑一个开工）

### 选项 A：P3 风格契约 + 参数快照 + 场景参考（推荐，价值最高）
解决用户最初的痛点"ComfyUI 高级调整怎么保证画风统一"。
- **项目级风格契约**：锁 checkpoint/LoRA/风格 overlay/负面词/采样器/steps/CFG/分辨率(复用现有 `artDirection.overlay` 与 per-project comfyui-preferences)；
- **分镜级只开放结构参数**(构图/机位/ControlNet 强度/seed/局部重绘)，风格区置灰；
- **生成参数快照**：每次生成存 storyVersion/styleContractVersion/seed/taskId/resultPath，并落地被搁置的 `basedOnStoryVersion`(P2a 收敛到此)；
- **场景参考轻量版**：项目传场景参考图 + 分镜标场景标签 + 生图时 overlay 注入(不建"场景工坊")。
- 切法：后端契约(参数快照存储/风格契约 CRUD)给 Codex 出任务书；分镜级 UI 收敛 + 检查器五区重组是 CC 热区活，可合批。

### 选项 B：检查器五区重组（CC 纯前端，较轻）
分镜检查器重组为五区：①镜头意图 ②构图/机位/景别/走位 ③项目风格契约(只读) ④当前分镜可调项 ⑤生成版本历史。机位派生从检查器顶部移下。可单独做，也可并进 P3。

### 选项 C：P4 交付包增强（Antigravity）
交付 zip 补 `characters/`(头像+三视图) + `scenes/` + `README.txt`；顺带修 Contact Sheet 的 DRAFT 角标换行小瑕疵("DRA FT")。给 Antigravity 出任务书即可。

## 待清理（不急）
- 完结工作包的 worktree 可删：`wt-export-deck-fix`、`.pnpm-store/worktrees/{shot-review-api,story-version,delivery-ui}`。
- 根目录草稿 `diff.txt`/`app_diff.txt`/`origin_diff.txt`/`capture_console.js`/`.codex-ui-v2-baseline.patch` 确认无用可删。
