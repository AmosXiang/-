# P2b 接线验收（CC · 2026-07-15）

WP-F（`feat/delivery-ui@bf69044`，Codex）契约抽查 PASS（边界零违规：仅两组件 + evidence，
无依赖、未碰热区与 server.ts；props 与契约一致；lint 独立复跑通过），已合入主线（`62bd550`）。

## CC 接线内容（App.tsx）

1. 向导第④步「导出」右栏顶部挂 `DeliveryPanel`；`onJumpToShot` 实现为：定位分镜下标 →
   `setSelectedShotIndex` + `setWorkspaceTab('image')` + `setCreativeStep(3)`；
2. 新增「👁 审阅预览（打印即 PDF）」按钮 → 全屏挂载 `StoryboardReview`；
3. 顺手修复第④步既有的 `#$1` 序号与 `&lcub;` 实体两处显示 bug。

## 真机闭环验证（真实项目《孤岛豪宅谋杀案》74 镜，dev 端口 3000/3001）

- 交付检查：面板渲染统计卡，**「导出正式交付包」禁用且给出精确原因"仍有 73 镜未定稿"**
  （该项目此前真机定稿过 1 镜，数字吻合）；73 行缺项清单全部可点；
- **回跳**：点击「#2 未定稿 · 跳转 →」→ 落到第③步、分镜列表选中 `#2 (00:05)`、分镜画面 tab 激活；
- **审阅预览**：全屏渲染封面 + 74 张镜卡 + Contact Sheet + DRAFT 标记 + 打印按钮；
- **审阅稿导出（端到端真实执行）**：POST review 模式成功，
  `storyboard-deck.pptx / storyboard-manifest.json / storyboard-delivery.zip` 三个下载链接就位；
- `tsc` 通过、控制台（error 级）零输出。

## 关联事项

- WP-C 渲染级验收已另行闭环（LibreOffice 渲染逐页人眼核查，完整 PASS，
  见 `wpc-visual-recheck.md` 增补；遗留一处 Contact Sheet DRAFT 角标换行小瑕疵，转小修）。
- 至此 **P2（P2a+P2b）创作闭环全部落地**：故事编辑→版本→评审定稿→交付检查→双模式导出。
