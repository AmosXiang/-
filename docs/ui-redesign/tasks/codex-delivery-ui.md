# 任务书（Codex）：P2b 交付检查/导出面板 + 工具内 HTML 审阅预览（WP-F）

> 全文直接粘贴给 Codex。上下文自包含。
> 方案依据：`docs/ui-redesign/workflow-redesign-2026-07-14.md` §五 + `integration-plan-2026-07-14.md` 裁决 #6/#7。
> 基线：`feature/camera-derive` 最新 HEAD（含 WP-E 合入与 P2a 接线，以协调人通知的 hash 为准）。
> 分支：`feat/delivery-ui`。**强制独立 worktree。**

## 背景

后端已就绪（你 review 过的 WP-C）：`GET /api/generated-scripts/:id/delivery-check` 与
`POST /api/generated-scripts/:id/export-deck`（body `{ mode: 'final' | 'review' }`，final 未全定稿
返回 409 + `{ error, missing: [{ shotId, index, issues }] }`，issues 为八个固定 code；成功返回
`{ files: { pptxUrl, manifestUrl, zipUrl }, summary }`）。本任务做**纯前端组件**（两个新文件），
挂载接线由协调人 CC 完成。延续 WP-E 的授权模式：组件归你，热区（App.tsx/index.css/router.ts/main.tsx）禁碰。

## 交付物

### 1. `src/components/DeliveryPanel.tsx` — 交付检查 + 双模式导出

```ts
// 返回类型交给 TS 推断
export default function DeliveryPanel(props: {
  projectId: string;
  onJumpToShot?: (shotId: string) => void;  // 点击缺项行回跳对应分镜(由 CC 接线实现跳转)
})
```

- 挂载时 GET delivery-check，展示统计卡：总数 / 已定稿 / 未定稿 / 缺图 / 失败 / 缺参数 / 基于旧输入；
- details 列表按 issue code 翻译为中文（`not_finalized` 未定稿、`missing_image` 缺图、
  `image_not_local` 图非本地、`missing_camera`/`missing_framing`/`missing_duration` 缺参数、
  `stale_input` 基于旧输入、`latest_task_failed` 最新任务失败），每行可点击 → `onJumpToShot(shotId)`；
- 导出区双按钮（不允许静默漏镜头的 UI 表达）：
  - **「导出正式交付包」**（主按钮）：`notFinalized > 0` 时禁用并显示原因；点击 POST `mode:'final'`；
    409 时把 `missing` 渲染成可点击清单；
  - **「导出审阅稿」**（次级按钮）：随时可用，POST `mode:'review'`；按钮下注明"未定稿镜头将标 DRAFT"；
- 导出成功后展示三个下载链接（PPTX / manifest / zip，直接 `<a href>` files 里的 URL）+ summary 摘要
  （含 stale 数提示"N 镜基于旧输入，已在手册中标注"）；
- 导出中 loading 态、失败态明确展示；「重新检查」按钮刷新 delivery-check。

### 2. `src/components/StoryboardReview.tsx` — 工具内 HTML 审阅预览（浏览器打印即 PDF）

```ts
export default function StoryboardReview(props: {
  script: any;              // GeneratedScriptRecord,自包含渲染,不发请求
  onClose?: () => void;
})
```

- 纯读渲染整份分镜手册的网页版，暗色工作台风格但**打印友好**（组件内 `<style>` 带
  `@media print` 覆盖：白底黑字、每镜一页 `break-inside: avoid`、隐藏按钮）；
- 结构：封面块（newTitle / topic / 叙事三要素 / 角色行）→ 每镜一卡（序号+时间码+时长、定稿图或
  降级图或"未生成"占位、运镜/景别/机位参数行、description、optimizedPrompt、
  未定稿标 DRAFT 角标、`isStale` 标"⚠ 基于旧版剧本"）→ 尾部 Contact Sheet 缩略网格；
- 图片一律 `object-fit: contain` 不拉伸；空/失败显示文字占位（参照 App.tsx 的 SafeImg 思路，
  组件内自实现，不 import App）；
- 顶部工具条：「🖨 打印 / 导出 PDF」（`window.print()`）+「关闭」（调 `onClose`）。

## 测试与验收

- `npm run lint` 与 `npm run build` 通过（项目无前端测试框架）；
- 组件不得引入新依赖、不得改任何既有文件（除本任务书要求的两个新文件外零文件变更——
  server.ts 本次也**不需要**改动）；
- 验收证据：`docs/ui-redesign/tasks/evidence/delivery-ui-acceptance.md`（lint/build 输出 +
  组件 props 契约自查表；真机联调由 CC 接线后补充）。

## 边界（违反即返工）

只新建两个组件文件；App.tsx / index.css / router.ts / main.tsx / server.ts / 各后端模块禁碰；
不加依赖；提交前缀 `feat(delivery-ui): ...`；不 push；完成后通知 CC review 与接线。
