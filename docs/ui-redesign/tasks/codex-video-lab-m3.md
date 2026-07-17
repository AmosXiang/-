# 任务书（Codex）：Video Lab M3 视频交付与打包 · 重试 · Take 清理

> 全文直接粘贴给 Codex。上下文自包含。
> 方案依据：`docs/ui-redesign/video-lab-plan-2026-07-15.md` §五B/§五D/§七 M3。
> 消化两条顺延备忘：备忘①（provider 输出维度只信实物，M1/M2 两轮 ffprobe 实证 normalized_size 与实物不符）→ manifest 的 actual 块全部 ffprobe 实测；备忘②（durationSec 回填）→ manifest actual.durationSec 用 ffprobe 实测，不落库不改 schema。
> M2 真机新事实：**Agnes 限流 1 request/min**（`video generation rate limit exceeded: allows 1 requests per 1 minute(s)`），批量串行 >1 镜必然部分失败，M2 的"失败保留审计不阻断"行为正确，本包补 UI 侧应对。
> 分工：本包归你（coding+验证+提交）；CC 负责 server.ts deps 回调实现（probeVideo/redownloadVideo/deleteVideoTaskRow 等）、review、真机回归。
> 基线 `feature/camera-derive@c4a22e8`。分支：`git worktree add -b feat/video-lab-m3 ../wt-video-lab-m3 c4a22e8`（强制独立 worktree）。

## 一、M3 范围拍板（越界即返工）

**做**：①manifest/README 引用定稿视频（相对路径+任务信息+ffprobe 实测块）；②可选打包定稿视频进 ZIP（默认关闭，硬规则 D）；③导出时二次落盘校验（硬规则 B）；④下载失败重试端点+UI；⑤Take 删除清理；⑥批量限流应对（capability 声明 + UI 提示 + 失败重试入口）。
**不做**：视频转码/压缩、Animatic 混播（已砍）、时间线剪辑、批量端点异步化/服务端排队（见 §六节流拍板）、video_tasks schema 变更。

## 二、export-deck 侧（视频交付三件套）

### 2.1 deps 扩展（注册形状，CC 接线）

```ts
// registerExportDeckModule(app, db, deps) 的 deps 追加可选块；缺席时导出行为与 M2 完全一致（零视频信息，不报错）
videoDelivery?: {
  getVideoTask: (taskId: string) => VideoTaskRow | undefined;   // CC 复用 videoTaskRow
  probeVideo: (absPath: string) => { width: number; height: number; fps: number; durationSec: number } | null;  // CC 用 ffprobe 实现；探测失败返回 null
};
```

模块自身不碰 sqlite、不 spawn 进程（保持可 stub 全覆盖）。本地路径解析复用本模块 `naming.ts` 的 `getLocalPath` + `isReadableFile`。

### 2.2 导出时二次校验（硬规则 B，对每个带 `finalVideoTaskId` 的 shot）

逐项检查：task 存在 → `shot_id` 匹配 → `status==='completed'` → `local_path` 非空 → getLocalPath 解析成功 → isReadableFile 为真。
**任一不过** → 该 shot 的 manifest `finalVideo.status = "missing"` 并附 `reason`（沿用 M2 五 code 字符串），**绝不引用/拷贝该文件**；导出不阻断（视频是可选交付物，与图片定稿的 final-mode 409 语义不同）。`summary` 新增 `finalVideos: { present, missing, totalBytes }`。

### 2.3 manifest shots[] 追加块（仅 `finalVideoTaskId` 存在时出现）

```jsonc
"finalVideo": {
  "taskId": "…", "provider": "agnes", "seed": 8234022103841080,
  "status": "ok" | "missing", "reason": null | "TAKE_FILE_MISSING…",
  "sourcePath": "/uploads/videos/<id>.mp4",        // 服务器引用路径（不打包时下游用它取）
  "file": "videos/shot-01.mp4" | null,              // 仅勾选打包且拷贝成功时非 null
  "fileBytes": 453789,
  "requested": { "durationSec": 3, "fps": 24, "resolution": "1152x768" },   // 快照口径
  "actual": { "width": 1088, "height": 832, "fps": 24, "durationSec": 3.375 } | null  // ffprobe 实测；probeVideo 返回 null 时置 null
}
```

`requested` 从 `generation_snapshot_json.parameters` 读；**禁止把 provider 的 `normalized_size` / `normalized_seconds` 写进 actual**（备忘①②的全部意义）。

### 2.4 可选打包（硬规则 D）

- `POST /api/generated-scripts/:id/export-deck` body 追加 `includeFinalVideos?: boolean`，**缺省 false**。
- `true` 时：status ok 的视频拷入 `exportDir/videos/shot-NN.mp4`（NN 与 finals/ 同一编号法），ZIP 自然收录；`false` 时不建 videos/ 目录。
- `GET /api/generated-scripts/:id/delivery-check` 响应追加 `finalVideos: { count, totalBytes }`（按实际文件 stat 求和，供 UI 复选框显示"预计增加 X MB/GB"，硬规则 D 原文）。
- README.txt：追加 videos/ 目录说明（仅打包时）与"定稿视频清单"小节（逐镜 status/实测尺寸时长；missing 附 reason）。

## 三、video-lab 侧（重试 · 删除 · 限流应对）

### 3.1 deps 再扩两项（接口你定形状，实现 CC 提供；M1/M2 deps 原样保留）

```ts
redownloadVideo: (taskId: string) => Promise<{ ok: boolean; error?: string }>;  // CC 复用既有下载内核；成功=local_path 回填+download_error 清空
deleteVideoTaskRow: (taskId: string) => void;                                    // 删行；本地文件由 CC 在实现内一并 unlink（路径穿越防护对齐 getLocalPath）
```

沿用 M2 先例：注册暂容缺席，未接线路由显式 `503 VIDEO_LAB_M3_NOT_CONFIGURED`。

### 3.2 `POST /api/video-lab/tasks/:taskId/retry-download?projectId=`

前置（4xx+code）：task 存在且其 shot 在项目内（404）；`status==='completed'`（422 `TASK_NOT_COMPLETED`）；`local_path` 为空或 `download_error` 非空（否则 409 `ALREADY_DOWNLOADED`）；`video_url` 非空（422 `NO_REMOTE_URL`）。
全过 → `redownloadVideo`；失败把错误如实写回并返回（**Agnes URL 有时效，过期重试必然失败——错误原样透出，禁止美化**）。返回更新后 task 行。

### 3.3 `DELETE /api/video-lab/tasks/:taskId?projectId=`

前置：task 存在且 shot 在项目内（404）；`status !== 'in_progress'`（422 `TAKE_IN_PROGRESS`，避免轮询回写孤儿行）；不是**任何** shot 的 `finalVideoTaskId`（全项目扫描，422 `TAKE_IS_FINAL`）。
全过 → `deleteVideoTaskRow`（行+本地文件）。返回 `{ deleted: taskId }`。

### 3.4 批量限流应对（M2 真机事实驱动）

- `AGNES_VIDEO_CAPABILITY` 追加 `minSubmitIntervalMs: 61_000`（capability 类型加可选字段）。
- **批量端点行为不变**（串行、不 sleep、失败保留审计——不引入长挂请求）。
- 成本确认层追加一行：Provider 声明 `minSubmitIntervalMs` 且镜头数 >1 时显示「该 Provider 限流约 1 任务/分钟，本批第 2 镜起可能提交失败，失败镜头可稍后一键重试」。
- 批量结果 failed 明细区追加「重试失败镜头」按钮：预选这些 shotIds，**重走完整闸门流程**（成本确认层不可跳过）。

## 四、前端（`VideoLabPanel.tsx` + `DeliveryPanel.tsx`）

1. **VideoLabPanel**：`download_error` 的 take 行加「重试下载」（3.2，进行中态+结果刷新）；非定稿 take 行加「删除」（二次确认文案含 seed/时间；`TAKE_IS_FINAL`/`TAKE_IN_PROGRESS` 中文映射）；成本层限流提示 + 失败重试按钮（3.4）。
2. **DeliveryPanel**：导出区加「☐ 同时打包定稿视频（预计增加 X）」复选框，**默认不勾选**；X 来自 delivery-check `finalVideos.totalBytes`（<1GB 显示 MB，≥1GB 显示 GB 一位小数）；count=0 时复选框禁用置灰。导出请求透传 `includeFinalVideos`。
3. 不加导出进度条、不加视频预览进交付面板（越界）。

## 五、测试与验收

- export-deck（deps 全 stub）：二次校验五种失败态逐一 → status missing+reason 且零拷贝；ok 态 manifest 块字段齐全且 actual 来自 probeVideo stub 而非 normalized_*；includeFinalVideos 缺省 false 不建目录；true 时 videos/ 拷贝+ZIP 收录+README 小节；videoDelivery deps 缺席 → 输出与 M2 基线逐字节等价；delivery-check totalBytes 求和正确。
- video-lab：retry-download 全部 4xx code + 成功路径 + 下载失败错误透出；DELETE 的 404/TAKE_IN_PROGRESS/TAKE_IS_FINAL（含"另一 shot 定稿指向它"用例）+ 成功删除；capability 新字段向后兼容（M1/M2 测试零改动通过）。
- `npm run lint` + `npm run build` + 全模块测试全过（54/54 + 新增）。
- 真机（CC 执行）：真实定稿数据导出（不勾选→manifest 引用+actual=ffprobe 实测；勾选→ZIP 含 videos/ 且解压可播）；重试下载对过期 Agnes URL 的诚实失败；删除非定稿 take 后文件消失、定稿 take 拒删。
- 证据：`docs/ui-redesign/tasks/evidence/video-lab-m3-acceptance.md`。

## 六、边界（违反即返工）

- **允许改动**：`server/modules/export-deck/**` 及其测试、`server/modules/video-lab/**` 及其测试、`src/components/VideoLabPanel.tsx`、`src/components/DeliveryPanel.tsx`、证据文档——此外零改动。
- **禁碰**：server.ts、App.tsx、index.css、router.ts、main.tsx、AnimaticPlayer.tsx、其他 server/modules/——CC deps 回调等你交付后统一做。
- 不建表、不改 video_tasks schema、不加 npm 依赖、模块内不 spawn 进程；正式 db/uploads 零污染、真实 provider 计费调用零发生（验收全 stub）。
- **节流拍板记录（CC 定，可复议）**：不做服务端 sleep/异步排队——100 镜 × 61s 的长挂请求不可接受；采用"诚实失败 + UI 一键重试"路线。若用户改判为服务端排队，另开任务书。
- 提交前缀 `feat(video-lab): ...`，不 push，完成通知 CC。

## 七、CC 接线备忘（非 Codex 范围）

server.ts：export-deck register 追加 `videoDelivery`（getVideoTask=videoTaskRow；probeVideo=spawn ffprobe，路径取 FFMPEG_PATH 同目录 ffprobe 或 PATH，超时+失败返回 null）；video-lab register 追加 `redownloadVideo`（复用既有 Agnes 下载内核，注意与轮询下载共用的临时文件+rename 语义）、`deleteVideoTaskRow`（DELETE 行 + getLocalPath 解析后 unlink，文件不存在不报错）。真机回归含：M1 单镜头、M2 定稿/批量不回归；export-deck 无视频项目导出与 M2 基线等价。
