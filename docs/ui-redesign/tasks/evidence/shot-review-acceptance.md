# WP-B 分镜评审 API 验收证据

验收日期：2026-07-14

分支：`feat/shot-review-api`

基线：`e1e5873`

## 结论

**PASS**。五个锁定端点均已通过自动化测试和真实项目数据的 HTTP 全流程验收；正式 `db.sqlite` 未被写入。

## 自动化验证

```text
> npx tsx --test server/modules/shot-review/*.test.ts
tests 6
pass 6
fail 0
```

覆盖项：版本倒序和 `isFinal`、旧 Shot 兼容、非法定稿任务拒绝、远程/越界/缺失图片拒绝、定稿及取消定稿不改 `isStale`、批量标记原子性、prompt/机位快照过期判断。

```text
> npm run lint
PASS

> npm run build
PASS（仅有既存的 Vite chunk > 500 kB 警告）

> git diff --check
PASS
```

## 真实项目 curl 全流程

为避免污染生产状态，服务在隔离端口 `49910` 启动，使用正式 `db.sqlite` 的副本；`UPLOADS_DIR` 指向真实本地 `uploads/`，因此定稿校验读取的是实际图片文件，而非伪造 fixture。

- 项目：`孤岛豪宅谋杀案：深宅谜影`
- projectId：`1783192733645`
- shotId：`8049cc6e-e3c6-4f37-82c6-ddf5e3ca8d8f`
- taskId：`83db1f5b-8407-4f85-a25b-cc5fd9e16ebf`
- 定稿图：`/uploads/projects/1783192733645/shots/03/comfyui-e3b2d49b4e0fb57db16b488fb7aa1855c76e3d562ba61a1b1c70b3df95e79a68.png`
- 本地文件存在：`true`

依次用 `curl.exe` 调用：

```text
GET    /api/generated-scripts/:id/shots/:shotId/versions
PUT    /api/generated-scripts/:id/shots/:shotId/final
GET    /api/generated-scripts/:id/shots/:shotId/versions
DELETE /api/generated-scripts/:id/shots/:shotId/final
POST   /api/generated-scripts/:id/stale-check
PUT    /api/generated-scripts/:id/shots/mark-stale  (true，再恢复 false)
```

汇总输出：

```json
{"versionsBefore":2,"beforeFinalCount":0,"putFinalTaskId":"83db1f5b-8407-4f85-a25b-cc5fd9e16ebf","afterFinalCount":1,"deleteRemoved":true,"staleCount":26,"markedIsStale":true,"restoredIsStale":false}
```

这证明：版本列表返回两次真实生成；PUT 后恰有一个版本标记 `isFinal`；DELETE 清除两个定稿字段；stale-check 只读返回结果；mark-stale 可写入并恢复。

## stale-check v1 判定口径

当前表结构没有完整的“生成输入指纹”。因此按任务书允许的 v1 fallback：对每个分镜取最新成功主图任务，将任务 `prompt` 快照与当前 `optimizedPrompt`（缺失时用 `description`）归一化比较；确定性的 `IDENTITY PRIORITY ... SHOT:` 前缀会先剥离；机位派生任务改与 `cameraPromptUsed` 比较。

局限：若历史任务经过翻译、风格 overlay 或其他未单独持久化的组装步骤，而 Shot 又没有 `optimizedPrompt`，可能产生保守的过期提示。该结果只用于提示，不自动写 `isStale`；完整结构化输入指纹追踪留到 P3。
