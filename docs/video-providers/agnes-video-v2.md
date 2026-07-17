# Agnes Video V2.0 Provider

## 数据保留原则（强制）

本地下载完成的 MP4 是视频成品的**唯一真相源（source of truth）**。

- `video_tasks.video_url` 指向 provider 的临时远程输出，只用于完成时下载，不能视为永久存储或恢复来源。
- `video_tasks.local_path` 指向的本地 MP4 一旦被删除，不能假设 Agnes 仍可下载，也不能通过相同 prompt、seed 和参数重新生成原文件。
- 相同 seed 和相同参数只用于复现性评估，不保证重新生成相同画面或相同二进制文件。
- 禁止清理脚本、测试 teardown、数据库 migration 或失败重试自动删除 `uploads/videos/` 中已完成任务的 MP4。
- 删除视频必须是显式、可审计的用户操作；执行前应提示“删除后无法恢复”。
- 需要跨机器保存或灾难恢复时，必须备份 `uploads/videos/`；只备份 SQLite 或远程 URL 不足以恢复视频成品。

`status = completed` 表示 provider 已完成并返回远程 URL。只有 `local_path` 非空且文件实际存在，才表示本地成品已经安全落地。下载失败时保持 `completed`，并在 `download_error` 中记录真实错误，运维人员可通过 `POST /api/video-tasks/:id/retry-download` 重新尝试下载；不得用空文件或 mock 文件代替。

## 当前接口

- 创建：`POST /api/video-tasks`
- 查询单个任务：`GET /api/video-tasks/:id`
- 列出任务：`GET /api/video-tasks`
- 重试下载：`POST /api/video-tasks/:id/retry-download`（仅限 `completed` 且保存了远程 URL 的任务；成功更新 `local_path` 并清空 `download_error`，失败返回 502 并如实记录 `download_error`。注意远程 URL 保留时长无保证，重试并非可靠恢复手段，不改变"本地 MP4 是唯一真相源"原则）
- Provider：`agnes`
- 模型：`agnes-video-v2.0`
- 本地目录：`uploads/videos/`

服务端以 5 秒间隔串行轮询，最多 120 次。Agnes 返回 `completed` 后，服务端立即将远程 MP4 下载到本地目录，并更新 `local_path`。

轮询错误语义：

- `503` 视为平台"处理中"，继续轮询（仍受 120 次总上限约束）。
- 其余 `5xx` 与网络错误统一按瞬态处理：继续轮询，但连续超过 12 次（约 1 分钟）即以**最后一次真实错误**（而非笼统的 `timeout`）终止任务并写入 `error`。
- 任何一次成功的 HTTP 响应（含正常 pending）会清零连续失败计数。

## 密钥与仓库卫生

- `AGNES_API_KEY` 只能保存在本地 `.env` 或进程环境变量中。
- 请求日志不得包含 `Authorization`、`Bearer` 或 API Key。
- `.env`、`uploads/` 和 `*.log` 必须保持在 `.gitignore` 中。
- 提交前应执行：

  ```powershell
  rg -n -i -e "Authorization|Bearer|sk-" -g "agnes-acceptance*.log" .
  git log -p -- .env
  git check-ignore -v uploads/videos/example.mp4 agnes-acceptance.stdout.log .env
  git ls-files -- .env "uploads/**" "agnes-*.log"
  ```

第一条命令无匹配时 `rg` 返回退出码 1，这是“未发现敏感串”，不是扫描失败。最后一条命令应无输出。

## UNVERIFIED

- Agnes 远程视频 URL 的保留时长未在当前资料中得到保证。
- 相同 seed 与相同参数是否能稳定复现相同画面未得到保证。
- 完成响应中的 `remixed_from_video_id` 字段名可能随平台迭代变化；当前实现同时兼容常见 URL 字段并记录原始响应。
