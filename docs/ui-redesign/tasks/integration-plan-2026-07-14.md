# UI 重设计集成计划（2026-07-14 晚 · 汇总四方意见后定稿）

> 输入：Codex 进度同步、Antigravity WP-C 交付报告、ChatGPT 全案评审（15 节）、简化派意见。
> 原则：**按"个人工作室级"裁剪"制片厂级"设计**——已建成的能力不拆（沉没成本已付且有真实价值），
> 未建的按最小可用版立项；方案文档 v2.1 与任务契约继续有效。

## 一、当前事实（已核实）

| 工作包 | 分支@提交 | 状态 |
| --- | --- | --- |
| P0 止血 | `feature/camera-derive@0d5c452` | ✅ 已入基线 |
| P1 路由化第一批 | `feat/p1-routing@52fd81c` | ✅ 已交付并真机验证 |
| WP-B 分镜评审 API（Codex） | `feat/shot-review-api@18af37d` | ✅ PASS，可合入（6/6 测试、lint/build、真实 curl、正式库未动） |
| WP-C 导出交付包（Antigravity） | `feat/export-deck-api@b539ecb` | ⚠️ 代码门禁 PASS，**视觉验收 FAIL**，需修复后合入 |
| 工作区纪律 | — | 主工作区已收回 CC（feat/p1-routing）；Codex 自有 worktree；Antigravity 修复须开 worktree |

WP-C 阻塞根因（Codex 视觉复验确认）：`pres.layout = 'LAYOUT_16x9'` 是 10×5.625 英寸，
而全部坐标按 13.33×7.5 设计 → 5/5 页画布越界。应改 `LAYOUT_WIDE`。
（Antigravity 自报的 COM 渲染验证未拦住此问题——**视觉验收以复核方为准**的规则继续执行。）

## 二、批次 0（立即）：WP-C 修复 —— Antigravity

**强制前置：不得在主工作区操作。** 先执行
`git worktree add ../wt-export-deck-fix feat/export-deck-api`，在该 worktree 内完成：

1. `generator.ts`：`LAYOUT_16x9` → `LAYOUT_WIDE`；
2. 重新生成视觉验收 deck，重新渲染，确认 overflow 为 0；
3. 核对五类页面：封面 / 正常定稿 / DRAFT / 无图占位 / 长文本；
4. **（本批一并做）新增 Contact Sheet 镜头总览页**：全部分镜缩略图网格（每页 ≤16 格，可多页），
   用于一眼检查角色变脸/色彩跳变/景别节奏——放在分镜页之后、作为倒数第一页；
5. 更新 `docs/ui-redesign/tasks/evidence/export-deck-acceptance.md`，附截图，PARTIAL → PASS；
6. 追加提交：`fix(export-deck): use wide layout, add contact sheet, complete visual QA`。

## 三、批次 1（集成）：合并三分支 —— CC

1. CC 对 WP-B / WP-C 做契约合规抽查（issue code、isStale 不动、Windows 时间戳、409 零产物、
   files 返 URL、UPLOADS_DIR 注入、正式库零污染）；
2. 从 `e1e5873` 建 `feat/ui-v2-integration`，按序合并：WP-B(18af37d) → WP-C(修复后) → P1(52fd81c)；
   server.ts 注册区冲突由 CC 解（各一行 import + register，预期琐碎）；
3. 回归：`npm run lint` + 全部 node:test + 真机冒烟（路由三页刷新恢复、shot-review curl 全流程、
   export-deck review 模式导出并开 PPTX）；
4. 通过后合回 `feature/camera-derive`，作为后续所有批次的新基线；外部 agent 此后从新基线拉分支。

## 四、设计裁决（ChatGPT 全案 × 简化派 × 已建成现实）

| # | 建议 | 裁决 | 归属 |
| --- | --- | --- | --- |
| 1 | 故事版本与分镜版本分离（beat sheet 为源，分镜只标"基于故事 v几"，改故事不重生成） | **采纳**（两派共识，与 provenance 思路一致） | P2a 核心 |
| 2 | 结构化故事编辑器（十几个字段） | **采纳但砍到三块**：一句话故事 + 三幕/beat 列表 + 爽点时间轴；字段多则填写烦、生成易空值 | P2a |
| 3 | 风格契约（项目锁 checkpoint/LoRA/风格词/采样，分镜只开结构参数，生成存参数快照） | **采纳**（v2.1 已定），快照含 storyVersion/styleContractVersion/seed/taskId | P3 |
| 4 | 场景资产独立模块/场景契约 | **轻量版**：项目可传场景参考图 + 分镜标场景标签 + 生图时作 overlay 注入；不建"场景工坊"，撞到不够再扩 | P3 |
| 5 | 评审状态机（待评审/已看过/已定稿 三态） | **维持 WP-B 已建的简化版**（版本列表 + 定稿 + 过期），不加"已看过"态 | 已建成 |
| 6 | 双模式导出（正式/审阅稿） | **保留**——已建成且测试通过，防静默漏页价值真实；简化派"砍掉"意见到达时功能已完工，不拆 | 已建成 |
| 7 | PPTX 换 HTML 先行 | **PPTX 保留**（已建成，只差一行布局修复）；HTML 审阅做成**工具内交付预览页**（复用 React 组件，浏览器打印=白送 PDF），不做重复导出物 | P2b |
| 8 | Contact Sheet 总览页 | **采纳**，加进 PPTX（批次 0 一并做） | 批次 0 |
| 9 | 交付包补 characters/、scenes/、README.txt | **部分采纳**：characters/（头像+三视图拷贝）+ README.txt 进 P4；scenes/ 等场景资产落地后 | P4 |
| 10 | 创意项目列表"继续上次工作"卡片（故事/风格/角色/定稿进度 + 最后编辑时间） | **采纳**，定稿数依赖 WP-B 合入 | P1b |
| 11 | 分析页布局（左时间轴/右摘要折叠/顶部小摘要行） | **采纳**（v2.1 已定） | P1b |
| 12 | 视频生成独立 Video Lab（读交付包 manifest） | **采纳方向**，分镜链路稳定后立项，暂不排期 | 远期 |

## 五、批次总表（更新后）

| 批次 | 内容 | 负责 |
| --- | --- | --- |
| **0 立即** | WP-C 修复 + Contact Sheet + 视觉 PASS | Antigravity（worktree 强制） |
| **1 集成** | 契约抽查 → ui-v2-integration 三分支合并 → 回归 → 合回主线 | CC |
| **P1b** | 分析页布局重构、系统抽屉收紧、tab 进 URL、项目卡"继续上次工作" | CC |
| **P2a** | 故事编辑三块 + 故事版本存储 + 分镜"基于旧输入"标注（`isStale`；与具体故事版本号的数值绑定 `basedOnStoryVersion` 需写生成链路，**收敛归 P3 参数快照**，2026-07-15 裁决）+ 定稿 UI（版本对比/设为定稿，接 WP-B API） | Codex：后端模块 + StoryEditor/ShotVersionPanel 两个独立组件（契约 codex-story-version.md）；CC：App.tsx 热区接线 |
| **P2b** | 检查器五区重组、交付检查 + 导出 UI（接 WP-C）、工具内 HTML 审阅预览 | CC |
| **P3** | 风格契约 + 参数快照、场景参考轻量版 | CC + Codex（后端） |
| **P4** | 交付包增强：characters/ 目录、README.txt（Contact Sheet 已提前到批次 0） | Antigravity |

## 六、协作纪律（因 2026-07-14 撞车事故固化为规则）

1. **主工作区永久归 CC**（前端热区独占）；外部 agent 一律 `git worktree add`，禁止在主工作区切分支；
2. 视觉/交互类验收以**复核方**结论为准，自报 PASS 不作数；
3. 合并只经集成分支，由 CC 统一执行与回归；
4. 每批次交付照旧：验收证据 markdown + 可复现步骤 + 真实输出。
