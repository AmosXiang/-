# WP-B 契约合规抽查（复核方：Claude Code · 2026-07-14）

对象：`feat/shot-review-api@18af37d`（Codex）。方法：对象库读 diff + 全量读 workflow.ts/routes.ts + 测试独立复跑。

## 结论：**PASS，可合入**，无需返工。

## 逐项核查

| 契约点 | 结果 |
| --- | --- |
| server.ts 限 1 import + 1 register | ✅ 恰好两行（L17 import / L7420 register，注入 `{ mutateDb, uploadsDir }`） |
| types.ts 只加三个可选字段 | ✅ finalTaskId / finalizedImageUrl / isStale，带注释，风格与 camera-derive 字段一致 |
| 五个 API 路径与契约完全一致 | ✅ |
| PUT final 校验链 | ✅ 存在 → 归属（projectId+targetId+targetType='shot'+viewType='main'）→ succeeded → 有图 → `/uploads/` 本地 → 防路径穿越（含 Windows 大小写不敏感前缀比较、\0 拒绝、URL 解析兜底）→ 文件真实存在 |
| **final 只写两字段、不碰 isStale** | ✅（v2.1 三维正交的关键点），并有专门测试 `finalize and cancel preserve the independent isStale flag` |
| DELETE final 只清两字段 | ✅ |
| versions 倒序 + isFinal | ✅ createdAt DESC + rowid 决胜 |
| stale-check 只读 + v1 fallback 如实注释 | ✅ prompt 快照比对，camera-derive 走 cameraPromptUsed，identity 前缀剥离；代码注释与验收文档均声明口径 |
| mark-stale 批量 + 严格校验 | ✅ 未知 shotId 整批拒绝（比契约更严，好） |
| 错误处理 | ✅ 400/404 + machine-readable `code`，无静默降级 |
| 无新依赖 / 无新表 / 不碰其他 src/** | ✅ diff 范围仅 7 文件 |
| 测试隔离 | ✅ `:memory:` SQLite + `mkdtemp` 临时 uploads，零真实库污染 |
| 测试独立复跑（复核方执行） | ✅ `npx tsx --test` 6/6 PASS（2026-07-14，于其 worktree） |
| 验收证据 | ✅ evidence/shot-review-acceptance.md：隔离端口 + db 副本 + 真实 uploads 图片 curl 全流程 |

## 非阻塞观察（合入后可不处理）

1. PUT final 的 validate 与 mutateDb 写入之间存在理论 TOCTOU 窗口——单用户本地工具可忽略。
2. stale-check v1 口径偏保守（prompt 文本比对），可能误报"过期"；只读不自动标记，符合任务书允许的 fallback，完整输入指纹归 P3 参数快照。
