# P2a 接线验收（CC · 2026-07-15）

WP-E（`feat/story-version@a1ae8a9`，Codex）契约抽查 PASS（范围合规：server.ts 2 行、types.ts 契约字段、两组件未碰热区、无 JSX.Element、无新依赖；测试 6/6 独立复跑通过），已合入主线（`fe5f18a`）。

## CC 接线内容（App.tsx，唯一热区改动）

1. 创意工作室向导头部新增「📖 故事编辑 v{n}」按钮 → 模态挂载 `StoryEditor`，`onSaved` 联动 `refreshGeneratedScripts()`；
2. 分镜工作台「分镜画面」tab 下方挂载 `ShotVersionPanel`，`onShotUpdated` 同步更新 `generatedScript.newShots`；
3. 分镜列表项新增「定」（已定稿，绿）/「旧」（基于旧输入，琥珀）徽标。

## 真机验证（真实项目《孤岛豪宅谋杀案》74 镜）

- 故事编辑模态：GET 派生初稿正常（beat×3 自 newNarrative、爽点×6 自动时间提取）、三块编辑区/标旧勾选/保存/版本历史齐全；
- 版本面板：真实分镜显示 2 条生成记录（模型/seed/时间）；
- **定稿全闭环**：点击「设为定稿」→ 面板转"已定稿 + 取消定稿"、分镜列表即时出现「定」徽标（onShotUpdated 状态同步验证通过）；
- `tsc` 通过、控制台（error 级）零输出。

Codex 侧后端验收另见 `story-version-acceptance.md`（随 WP-E 合入）。
