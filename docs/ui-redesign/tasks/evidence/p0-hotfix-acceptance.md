# P0 止血验收证据（WP-A · Claude Code · 2026-07-14）

方案依据：`docs/ui-redesign/workflow-redesign-2026-07-14.md` §七 P0。
验证方式：`npm run lint`（tsc --noEmit）+ 本地 dev 服务器（vite:49840 / express:49841）真机 DOM 检查，
项目样本《孤岛豪宅谋杀案：深宅谜影》（75 个分镜）。

## 修复清单与验证结果

### ① 分镜生成工作台滚轮失效 — 已修复
- 改动：`src/App.tsx` 中央编辑列滚动容器移除 `justify-center items-center`，
  改为内层 `<div class="m-auto w-full">` 包裹（justify-center 在内容溢出时会裁掉顶部且无法滚回）。
- 证据（运行时测量）：
  - 分镜列表列：`scrollHeight 6158 / clientHeight 638`，`scrollTop=300` 生效 → 可滚动到全部 75 个分镜；
  - 中央列内容矮时：wrapper `margin-top/bottom = 119.06px/119.06px` → m-auto 垂直居中生效；
    内容高于容器时按标准滚动容器工作（不再双端裁剪）。
- 备注：验证中确认了更深一层机制——`.wizard-shot-grid` 高度由 `min-height:640px` 兜底约束，
  列在 640px 网格内正确激活内部滚动。窄视口（≤1200px）走 `max-height:none` 分支由外层工作区滚动。

### ② 点击分镜偶发黑屏 — 已加全局防护
- 改动：新增 `src/components/ErrorBoundary.tsx`，`src/main.tsx` 将 `<App/>` 包入边界；
  渲染异常时显示可恢复报错面板（错误详情 + 尝试恢复 / 重新加载），不再整页卸载成黑屏。
- 防御加固：`shot.timestamp.split(" - ")` 两处（App.tsx 分镜列表 / 时间轴）改为 `(shot.timestamp || "")`,
  消除 timestamp 缺失时的 TypeError（黑屏最可能触发路径之一）。
- 证据：`npm run lint` 通过；应用经边界正常渲染、控制台零错误。崩溃注入未做（StrictMode 下人为抛错
  会污染开发态，P1 路由化后补 e2e）。

### ③ 分镜序号显示 `#$1 ($00:00)` — 已修复
- 改动：App.tsx JSX 中误写的模板字符串 `#${idx + 1} (${...})` 改为 `#{idx + 1} ({...})`。
- 证据：运行时首个分镜标签渲染为 `#1 (00:00)`；全页搜索 `#$` 零匹配。

### ④ 角色图破图 — 已修复
- 改动：新增 `SafeImg` 组件（src 为空 →"暂无图片"；加载失败 →"加载失败"，src 变更自动重置），
  替换 6 处直渲染 `<img>`（创意概览角色卡三视图 ×3、角色抽屉三视图 ×3，原 onError 仅 console.log）。
- 证据：当前项目 32 张图 0 破图；注入不存在的 `/uploads/definitely-missing-p0-test.png` 后，
  该图位在请求返回后替换为"加载失败"占位块，无浏览器破图图标。

### ⑤ "已保存到云端"文案 — 已修复
- 改动：分镜检查器数据同步提示改为"✓ 已保存到本机"（数据实际写入本机 SQLite）。
- 证据：运行时全页文本含"已保存到本机"、不含"已保存到云端"。

## 遗留说明

- "刷新回到初始页"在 P0 仅间接缓解（黑屏少了、被迫刷新就少了），根治依赖 P1 路由化（方案 §七）。
- `npm run lint` 全量通过；dev 控制台（error 级）零输出。
- 改动文件：`src/App.tsx`、`src/main.tsx`，新增 `src/components/ErrorBoundary.tsx`（`index.css` 未改动）。
