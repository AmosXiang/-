# Video Lab M1 验收证据

日期：2026-07-16

分支：`feat/video-lab-m1`

实现基线：`c56ae25`

## 1. 范围与边界

本包新增：

- `server/modules/video-lab/capability.ts`
- `server/modules/video-lab/workflow.ts`
- `server/modules/video-lab/routes.ts`
- `server/modules/video-lab/index.ts`
- `server/modules/video-lab/routes.test.ts`
- `src/components/VideoLabPanel.tsx`
- 本验收文件

未修改 `server.ts`、`src/App.tsx`、`router.ts`、`main.tsx`、`src/types.ts`、其他 `server/modules/**`、`AnimaticPlayer.tsx` 或 `animaticPlaylist.ts`。没有新增表、npm 依赖、Take/定稿/批量/成本/ZIP 入口。自动化验收只使用 stub，未读取或修改正式 `db.sqlite`、正式 `uploads/`，真实 Provider 调用为零。

## 2. Agnes capability 逐项代码复核

以下行号均指基线 `c56ae25` 的 `server.ts`，声明与现有代码可证事实一致：

| 声明项 | M1 值 | `server.ts` 证据与结论 |
|---|---|---|
| `textToVideo` | `true` | `48-56` 的完整请求 DTO 含 `prompt`，`105-115` 的 Agnes 请求体将其序列化为 `prompt`。 |
| `imageToVideo` | `false` | `48-56` 的完整请求 DTO 与 `105-115` 的完整 Agnes 请求体均没有首帧、参考图或图像输入字段；不能声明支持。 |
| `firstLastFrame` | `false` | 同上，DTO/请求体没有首帧或末帧控制字段；不能声明支持。 |
| `durations` | `[3, 5, 10, 18]` | `465` 给出唯一帧数映射；`483-485` 只接受这四个秒数。 |
| `resolutions` | `['1152x768']` | `494-495` 将请求尺寸固定为 `width: 1152`、`height: 768`。 |
| `aspectRatios` | `['3:2']` | `494-495` 的固定请求尺寸约分为 `3:2`。 |
| `fpsOptions` | `[24]` | `486` 的既有缺省值为 24；`487` 的 1-60 只是本地宽校验，没有 Provider 全域能力证据，因此 M1 只声明代码可证的 24。 |
| `supportsAudio` | `false` | `48-56` 与 `105-115` 没有音频输入/开关；按“核对不到即 false”处理。 |
| `supportsNativeCameraControl` | `false` | `48-56` 与 `105-115` 没有结构化原生运镜参数；M1 仅把运镜写入文本 prompt。 |

边界复核：`normalized_size` 不是请求能力。`604-616` 显示它来自 `createTask` 的响应 `raw.size`，随后才写入 `video_tasks.normalized_size`；M1 未用它扩展分辨率声明。

复核结果：**PASS，未发现任务书 §二声明与基线代码不符。**

## 3. 后端覆盖

命令：

```powershell
npx tsx --test server/modules/video-lab/routes.test.ts
```

结果：**9/9 PASS**。覆盖：

- providers 端点完整 shape 与 `configured`；
- 项目、shot、provider、配置校验顺序与 machine-readable code；
- Agnes 拒绝 `imageToVideo` / `firstLastFrame`，测试专用 fixture provider 接受三模式；
- duration/FPS/resolution 枚举越界；
- 画幅契约直通、无 decision 的 409、显式 crop/letterbox 入快照；
- 六段 motion prompt 的段序、空段跳过、强度短语在 camera movement 前注入；
- 完整 snapshot 与 `submitVideoTask` 入参逐字段一致；
- 空 `subjectScene` 返回 422 `SUBJECT_SCENE_REQUIRED`。

## 4. 前端关键状态

- 模式 chips 只渲染 capability 为 `true` 的项；Provider 未配置时 option 与提交按钮均禁用。
- 时长、分辨率、FPS 均来自 capability 按钮组，不提供手输入口。
- motionPrompt 独立六字段；`optimizedPrompt` 与 `cameraPromptUsed` 仅作可编辑预填。
- 409 `ASPECT_UNSUPPORTED` 弹出更换模型/裁切适配/留边适配三选层；没有可替代 Provider 时更换模型禁用并显示原因。
- 任务轮询间隔 5 秒。落盘判定为三态：
  1. `completed + local_path`：终止轮询，允许 AnimaticPlayer 单条预览；
  2. `completed + 无 local_path + 无 download_error`：继续等待本地落盘；
  3. `completed + download_error`：立即终止轮询并显示下载错误。
- 状态 2 连续 60 秒仍无结果时终止等待，提示“落盘异常，请检查服务端日志”，并提供“重新检查”。
- 结果区只展示当前任务与本次参数快照；没有 Take 列表、定稿或批量 UI。

## 5. 完整自动化

| 验收项 | 结果 |
|---|---|
| `npx tsx --test server/modules/video-lab/routes.test.ts` | **PASS 9/9** |
| 全部 `server/modules/**/**.test.ts` | **PASS 46/46**（原 37 + Video Lab 9） |
| `npx tsx --test src/components/animaticPlaylist.test.ts` | **PASS 7/7** |
| `npm run lint` | **PASS** |
| `npm run build` | **PASS**（Vite 仅报告 >500 kB chunk 警告） |

## 6. 待 CC 接线与真机验收

本包遵守分工，未修改 `server.ts` / `App.tsx`。以下项目必须由 CC 接线后执行，当前不冒充已验证：

- `server.ts`：提取并注入 `submitVideoTask`、加入 `generation_snapshot_json` PRAGMA 守卫迁移、1 import + 1 register；
- `App.tsx`：挂载 `VideoLabPanel`；
- 使用真实 Agnes key + `db.sqlite` 副本完成一条 text-to-video：提交 → Provider 完成 → 本地 MP4 落盘 → `local_path` → AnimaticPlayer 播放 → 快照列核对；
- 回归既有 `POST /api/video-tasks` 直调路径，确认提取重构前后行为不变；
- 真机补测下载失败语义：`completed + download_error` 必须停止等待并显示错误。
