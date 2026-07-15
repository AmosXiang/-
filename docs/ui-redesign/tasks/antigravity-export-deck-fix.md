# 任务书（Antigravity）：WP-C 视觉验收修复 + Contact Sheet（批次 0）

> 全文直接粘贴给 Antigravity。这是对 `feat/export-deck-api@b539ecb` 的追加修复任务，
> 原契约 `docs/ui-redesign/tasks/antigravity-export-deck.md` 继续有效。

## 背景

你提交的 WP-C 代码门禁全部通过（测试 4/4、lint、build、目录名无冒号、路径穿越防护），
但**独立视觉复核 FAIL**：实际渲染 PPTX 后 5/5 页画布越界。根因已定位——

```js
pres.layout = 'LAYOUT_16x9';   // 10 × 5.625 英寸
```

而 `generator.ts` 全部坐标按约 13.33 × 7.5 英寸设计，导致封面右侧/底部、分镜右栏、
Prompt 区和页脚被裁切。你此前的 COM 渲染验证未拦住此问题，本次修复的视觉验收
**必须逐页人工核对截图**，结论以复核方（Claude Code）复验为准。

## 强制前置：工作区纪律（上次已发生撞车事故）

**禁止在主仓库工作区（`C:\Users\Owner\Documents\GitHub\-`）切分支或提交。**
先创建独立 worktree，全部工作在其中进行：

```bash
git worktree add ../wt-export-deck-fix feat/export-deck-api
cd ../wt-export-deck-fix
```

## 修复内容

1. `server/modules/export-deck/generator.ts`：`'LAYOUT_16x9'` → `'LAYOUT_WIDE'`（13.33 × 7.5 英寸，与现有坐标匹配）。
2. **新增 Contact Sheet 镜头总览页**（本批一并交付）：
   - 位置：全部分镜页之后、作为 deck 最后一节；
   - 内容：所有分镜的缩略图网格，每页最多 16 格（4×4），超出自动分页；
   - 每格：分镜图缩略（无图用占位格）+ 格下标注 `#序号`；DRAFT/无图格加角标；
   - 用途：一眼检查角色变脸、色彩跳变、景别节奏，属于人工审阅关键页；
   - manifest 不需要为此新增字段。
3. 重新生成视觉验收 deck（复用你的 `generate_visual_deck.js` 管线），重新渲染，确认 overflow 为 0。

## 视觉验收（不可用解包断言替代）

逐页截图核对**六类页面**：封面 / 正常定稿页 / DRAFT 页 / 无图占位页 / 长文本页（截断 +
"全文见 manifest"）/ **Contact Sheet**。检查项：文字不越界、图片不拉伸（contain）、中文
不乱码（Microsoft YaHei）、页脚完整。

## 交付

1. 更新 `docs/ui-redesign/tasks/evidence/export-deck-acceptance.md`：附六类页面截图，
   结论从 PARTIAL 升为 PASS；若任何一项无法验证，如实标注 PARTIAL 并写明原因，禁止虚报。
2. 追加提交（不要改写 b539ecb 历史）：
   `fix(export-deck): use wide layout, add contact sheet, complete visual QA`
3. 测试补充：为 Contact Sheet 增加至少一条断言（如 slide 数 = 固定页 + 分镜数 + ceil(分镜数/16)）。
4. 不 push；提交后通知协调人（Claude Code）复核并执行集成合并。

## 边界（沿用原契约）

只碰 `server/modules/export-deck/**` 与验收文档；不碰 `src/**`、server.ts 已注册行、
其他模块目录；无新依赖。
