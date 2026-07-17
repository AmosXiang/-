# Video Lab M3 验收证据（Codex）

日期：2026-07-16

分支：`feat/video-lab-m3`

基线：`c4a22e896b95065da203787fc24b95fdd469b808`

隔离 worktree：`C:\Users\Owner\Documents\GitHub\wt-video-lab-m3`

## 1. 范围与污染控制

- 改动仅位于 `server/modules/export-deck/**`、`server/modules/video-lab/**`、`src/components/VideoLabPanel.tsx`、`src/components/DeliveryPanel.tsx` 与本证据文档。
- 未改 `server.ts`、`App.tsx`、`index.css`、router、main、AnimaticPlayer、schema 或 npm 依赖。
- 测试全部使用内存 SQLite、`mkdtemp` 与 stub；未读取或写入正式 `db.sqlite`、`uploads/`，未调用真实 Provider，计费调用为 0。
- worktree 的 `node_modules` 是指向主仓库既有依赖的本地目录联接；没有执行依赖安装，也没有仓库改动。

## 2. 已实现行为

### export-deck

- `videoDelivery` 为可选依赖；缺席时 delivery-check、manifest 与 README 保持 M2 路径，不出现视频字段。
- 每个 `finalVideoTaskId` 在导出复制前重新校验任务存在、shot 归属、completed、local_path、本地路径安全与文件可读性；五种失败分别写入 `TAKE_NOT_FOUND`、`TAKE_SHOT_MISMATCH`、`TAKE_NOT_COMPLETED`、`TAKE_NOT_DOWNLOADED`、`TAKE_FILE_MISSING`，但不阻断导出。
- manifest 的 `requested` 只读生成快照；`actual` 只读 `probeVideo`。测试任务故意携带 `normalized_size=1152x768`、`normalized_seconds=3.4`，断言输出仍为 probe stub 的 `1088x832 @ 24fps / 3.375s`。
- `includeFinalVideos` 默认 false，不创建 `videos/`；true 时仅复制复核通过的视频到 `videos/shot-NN.mp4`，ZIP 与 README 同步收录。
- delivery-check 返回实际文件 stat 汇总；导出 summary 返回 `{ present, missing, totalBytes }`。

### video-lab 与 UI

- 新增下载重试路由，覆盖 404、`TASK_NOT_COMPLETED`、`ALREADY_DOWNLOADED`、`NO_REMOTE_URL`、成功更新与原样错误透出；未接线返回 `503 VIDEO_LAB_M3_NOT_CONFIGURED`。
- 新增 Take 删除路由，覆盖 404、`TAKE_IN_PROGRESS`、任一项目镜头定稿引用的 `TAKE_IS_FINAL` 与成功删除。
- Take 行提供“重试下载”和带 seed/创建时间的二次确认删除；两种拒删码有中文映射。
- Agnes capability 声明 `minSubmitIntervalMs: 61_000`；多镜成本确认门显示 1 任务/分钟提示。
- 批量失败结果提供“重试失败镜头”，只预选失败 shotIds，并重新进入完整成本确认门。
- DeliveryPanel 的视频打包复选框默认关闭，count=0 时禁用；容量按 MB/GB 显示并透传 `includeFinalVideos`。

## 3. 自动化结果

| 命令 | 结果 |
| --- | --- |
| `npm run lint` | PASS，`tsc --noEmit`，退出码 0 |
| `npm run build` | PASS，2091 modules transformed，退出码 0；仅有既有 chunk-size warning |
| `tsx --test server/modules/export-deck/routes.test.ts` | PASS，8/8 |
| `tsx --test server/modules/video-lab/routes.test.ts` | PASS，21/21 |
| `tsx --test $(rg --files server/modules -g '*.test.ts')`（PowerShell 数组等价调用） | PASS，60/60，0 fail |

## 4. 留给 CC 的接线与真机项

以下内容按任务书分工不在本提交范围，当前标记为 **UNVERIFIED / 待 CC**：

- `server.ts` 为 export-deck 接入 `getVideoTask` 与真实 ffprobe `probeVideo`。
- `server.ts` 为 video-lab 接入复用下载内核的 `redownloadVideo` 与带安全路径校验/文件 unlink 的 `deleteVideoTaskRow`。
- 用真实定稿数据验证不打包/打包两种导出、ZIP 解压播放、过期 Agnes URL 的诚实失败、非定稿文件删除与定稿拒删。
- M1 单镜、M2 定稿/批量真实回归。
