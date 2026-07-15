# WP-F Delivery UI 验收证据

验收时间：2026-07-15

分支：`feat/delivery-ui`

基线：`feature/camera-derive@e57bbd3`

## 1. TypeScript 门禁

命令：

```powershell
npm run lint
```

结果：

```text
> react-example@0.0.0 lint
> tsc --noEmit

PASS
```

## 2. 生产构建

命令：

```powershell
npm run build
```

结果：

```text
vite v6.4.3 building for production...
✓ 2081 modules transformed.
✓ built in 2.90s
PASS
```

构建只出现仓库既有的 `chunk > 500 kB` 提示，不影响产物生成。

## 3. DeliveryPanel 契约自查

| 契约 | 实现 | 结果 |
| --- | --- | --- |
| Props | `projectId: string`、`onJumpToShot?: (shotId: string) => void` | PASS |
| 初始检查 | 挂载 GET `/api/generated-scripts/:id/delivery-check`，支持 AbortController | PASS |
| 统计卡 | 总数、已定稿、未定稿、缺图、失败、缺参数、基于旧输入 | PASS |
| issue 翻译 | 八个固定 code 均映射为中文 | PASS |
| 缺项跳转 | 点击行调用 `onJumpToShot(detail.shotId)` | PASS |
| 正式导出 | `notFinalized > 0` 禁用并显示具体数量 | PASS |
| 409 | 读取 `missing` 并渲染为同一套可点击缺项清单 | PASS |
| 审阅稿 | POST `mode: 'review'`，不受未定稿数量阻塞 | PASS |
| 防漏页说明 | 明示“未定稿镜头将标记 DRAFT，不会静默漏页” | PASS |
| 下载 | PPTX、manifest、ZIP 直接使用后端 URL | PASS |
| 状态 | 检查中、导出中、失败、成功、重新检查均有明确 UI | PASS |

## 4. StoryboardReview 契约自查

| 契约 | 实现 | 结果 |
| --- | --- | --- |
| Props | `script: any`、`onClose?: () => void` | PASS |
| 纯读 | 不发请求、不修改 script | PASS |
| 封面 | 标题、topic、叙事三要素、角色头像行、定稿进度 | PASS |
| 逐镜卡 | 序号、时间码、时长、导演参数、描述、Prompt | PASS |
| 图片优先级 | 有效定稿字段 → generatedImageUrl → imageUrl → 文字占位 | PASS |
| 图片失败态 | `onError` 自动尝试下一候选，全部失败显示“图片加载失败” | PASS |
| 状态标识 | 未定稿显示 DRAFT，过期显示“⚠ 基于旧版剧本” | PASS |
| Contact Sheet | 全部分镜缩略网格，显示 FINAL / DRAFT | PASS |
| 打印入口 | `window.print()`，按钮文案“打印 / 导出 PDF” | PASS |
| 打印隔离 | 打印时隐藏工作台其余内容，只显示审阅手册 | PASS |
| 打印配色 | A4 横向、白底黑字、图片 contain、不拉伸 | PASS |
| 分页 | 封面后分页，每镜避免拆分且镜后分页，Contact Sheet 新页 | PASS |

## 5. 文件边界

产品代码只新增：

- `src/components/DeliveryPanel.tsx`
- `src/components/StoryboardReview.tsx`

另按任务书新增本验收证据。没有修改任何既有文件，没有修改后端，没有新增依赖或 lockfile 变化。

## 结论

**PASS** — 两个组件的 props、API 契约、缺项/导出状态、图片降级和打印分页逻辑均符合 WP-F；真机挂载与回跳由 CC 接线后复验。
