# WP-E Story Version 验收证据

验收时间：2026-07-15

分支：`feat/story-version`

基线：`feature/camera-derive@3d6c961`

## 1. 自动化测试

命令：

```powershell
node --import tsx --test `
  server/modules/story-version/routes.test.ts `
  server/modules/shot-review/routes.test.ts `
  server/modules/export-deck/routes.test.ts `
  server/modules/camera-derive/workflow.test.ts
```

结果：

```text
tests 24
pass 24
fail 0
duration_ms 715.3595
```

其中 story-version 的 6 组测试覆盖：

- 未初始化项目派生建议初稿，高潮时间码去重提取，且 GET 不落库；
- 首次保存立即生成 v1 快照，缺失 beat/hook id 由服务端补 UUID；
- 连续保存递增版本并只保留最近 10 个快照；
- `markShotsStale` 严格按 succeeded + main + shot + imageUrl 非空查询并按 shot 去重；
- rollback 追加不可变新快照，回滚当前版本返回 `STORY_VERSION_ALREADY_CURRENT`；
- 不存在版本、坏 storyDraft、超长 note、非法 markShotsStale 返回 machine-readable 4xx code。

## 2. TypeScript 与生产构建

```text
npm run lint
> tsc --noEmit
PASS

npm run build
✓ 2079 modules transformed.
✓ built in 2.95s
PASS（仅保留仓库既有的 chunk >500 kB 警告）
```

## 3. db 副本真实 API / curl 全流程

测试前把正式 `db.sqlite` 复制到忽略目录：

```text
test-artifacts/story-version-acceptance/db.sqlite
```

测试服务器使用以下隔离配置启动：

```text
PORT=3017
SQLITE_DB_PATH=<worktree>/test-artifacts/story-version-acceptance/db.sqlite
UPLOADS_DIR=<worktree>/test-artifacts/story-version-acceptance/uploads
DISABLE_COMFY_WORKER=true
```

因此全部写入只发生在数据库副本；正式 `db.sqlite` 不是测试服务器的连接目标。
验收项目：`1783192733645`（《孤岛豪宅谋杀案：深宅谜影》）。

### GET 未初始化

```powershell
curl.exe -sS http://127.0.0.1:3017/api/generated-scripts/1783192733645/story
```

```json
{"initialized":false,"storyVersion":0,"storyDraft":{"logline":"孤岛豪宅谋杀案：深宅谜影","beats":["三幕结构","节奏","高潮设计"],"hooks":["02:23","02:30","04:02","04:10","04:21","04:32"]},"versions":[]}
```

上面为长响应的字段摘要；原响应包含完整 beat summary 和稳定派生 id。

### PUT v1

```powershell
curl.exe -sS -X PUT http://127.0.0.1:3017/api/generated-scripts/1783192733645/story `
  -H 'Content-Type: application/json' --data-binary '@v1.json'
```

```json
{"success":true,"storyVersion":1,"staleMarked":0}
```

### PUT v2 + markShotsStale

```json
{"success":true,"storyVersion":2,"staleMarked":26}
```

### GET 版本列表与 v1 全文

```json
{"initialized":true,"storyVersion":2,"versions":[{"version":2,"note":"curl v2"},{"version":1,"note":"curl v1"}]}
```

```json
{"version":1,"note":"curl v1","storyDraft":{"logline":"验收故事 v1","beats":[{"title":"开端","summary":"众人登岛"}],"hooks":[{"time":"00:20","label":"发现密室"}]}}
```

### rollback v1 → 新 v3

```powershell
curl.exe -sS -X POST http://127.0.0.1:3017/api/generated-scripts/1783192733645/story/rollback `
  -H 'Content-Type: application/json' --data-binary '@rollback.json'
```

```json
{"success":true,"storyVersion":3,"staleMarked":26}
```

副本最终状态核对：

```json
{"storyVersion":3,"storyLogline":"验收故事 v1","staleShots":26,"snapshotVersions":"1,2,3"}
```

## 4. 边界检查

- `server.ts` 仅新增 1 行 import + 1 行 register；
- 前端仅新增 `StoryEditor.tsx`、`ShotVersionPanel.tsx`；
- 数据模型只修改 `src/types.ts` 的 `GeneratedScriptRecord` 可选字段；
- 未修改 `App.tsx`、`index.css`、`router.ts`、`main.tsx`；
- 未修改 shot-review、export-deck、camera-derive、shot-analysis；
- 未建表、未新增依赖、未修改 lockfile；
- 正式 `db.sqlite` 未作为验收服务器写入目标。

## 结论

**PASS** — 后端契约、版本不可变语义、标旧 SQL 口径、两个自包含前端组件、类型检查、生产构建与数据库副本真实 API 流程均通过。
