# 任务书（Codex）：Video Lab M2 多 Take · 定稿 · 批量生成

> 全文直接粘贴给 Codex。上下文自包含。
> 方案依据：`docs/ui-redesign/video-lab-plan-2026-07-15.md` §四/§五B/§五C + M1 验收证据 §7 的两条 M2 备忘（`evidence/video-lab-m1-acceptance.md`）。
> 分工：本包归你（coding+验证+提交）；CC 负责 server.ts deps 回调实现、App.tsx 接线（Animatic 混播）、review、真机回归。
> 基线 `feature/camera-derive@f801086`。分支：`git worktree add -b feat/video-lab-m2 ../wt-video-lab-m2 f801086`（强制独立 worktree）。
> 主工作区有用户未提交的 index.css 改动——你禁碰 index.css（本包也不需要）。

## 一、M2 范围拍板（用户定，越界即返工）

**做**：按 shot 查询 Take 列表、Take 并排预览、`finalVideoTaskId` 定稿（硬规则 B）、批量生成 + 成本闸门（硬规则 C）、Animatic 混播数据面（playlist 升级 + final-videos 端点）。
**不做（留 M3）**：视频进交付包/ZIP/manifest 视频引用、导出时二次校验、下载失败重试 UI（download_error 的 take 显示错误且不可定稿即可）、Take 删除清理。

## 二、数据契约（形状锁定）

```ts
// src/types.ts — Shot 追加(可选 JSON 字段,零迁移;本字段由 CC 在 review 时确认唯一写入方是定稿端点)
finalVideoTaskId?: string;   // 指向 video_tasks.id;无 = 未定稿
```

Take = `video_tasks` 表现有行，不新增表、不改 schema。**Shot JSON 只存这一个指针，历史全留表里**（方案 §四.2）。

## 三、deps 扩展（接口你定，实现 CC 提供；M1 的 deps 原样保留）

```ts
type VideoLabDeps = {
  // ...M1 已有: readDb / submitVideoTask / isProviderConfigured
  mutateDb: (mutator: (db: any) => void) => void;              // 写 Shot.finalVideoTaskId(先例 scene-reference)
  listVideoTasksByShot: (shotId: string) => VideoTaskRow[];    // ORDER BY created_at DESC(idx_video_tasks_shot_created 已有)
  getVideoTask: (taskId: string) => VideoTaskRow | undefined;  // CC 用既有 videoTaskRow 提供
  isLocalVideoReadable: (localPath: string) => boolean;        // localPath 为 /uploads/... URL 形式;CC 负责解析到磁盘并校验存在+可读
};
```

模块自身不碰 sqlite（保持可 stub 全覆盖）。

## 四、后端端点（`server/modules/video-lab/` 内扩展，错误 4xx + code 风格沿用 M1）

1. `GET /api/video-lab/shots/:shotId/tasks?projectId=` → `{ tasks: VideoTaskRow[] }`
   校验项目/shot 存在（404，复用 M1 findProjectAndShot）；行按 created_at DESC；**不截断历史**。
2. `PUT /api/video-lab/shots/:shotId/final-video?projectId=` body `{ taskId: string | null }` —— 定稿/取消定稿。
   **硬规则 B 全量前置（方案 §五B，缺一即 422 + code）**：task 存在（`TAKE_NOT_FOUND`）、`task.shot_id === shotId`（`TAKE_SHOT_MISMATCH`）、`status === 'completed'`（`TAKE_NOT_COMPLETED`）、`local_path` 非空（`TAKE_NOT_DOWNLOADED`，download_error 非空时附带其内容）、`isLocalVideoReadable(local_path)` 为真（`TAKE_FILE_MISSING`）。
   全过 → mutateDb 写 `shot.finalVideoTaskId`；`taskId: null` → delete 该字段（干净删除，先例 WP-I untag）。返回更新后 shot。
   **临时远程 video_url 永远不能作为定稿依据**（Agnes URL 有时效）。
3. `GET /api/video-lab/final-videos?projectId=` → `{ finalVideos: Record<shotId, { videoUrl, durationSec, taskId }> }`
   遍历项目 shots 的 finalVideoTaskId：task 满足硬规则 B → 收录，`videoUrl = local_path`；
   **durationSec 回填顺序（M1 备忘②）**：`normalized_seconds` 有值用之，否则 `num_frames / frame_rate`，禁止用请求时的 durationSec；
   指针悬空/文件丢失 → **静默跳过该 shot 并在响应附 `degraded: [{shotId, reason}]`**（不 500——animatic 回退图片是正确行为）。
4. `POST /api/video-lab/batch-shot-tasks` body：
   `{ projectId, shotIds: string[], provider, durationSec, fps, resolution, motionStrength, negativePrompt?, aspectDecision?, confirmed: boolean }`
   - `confirmed !== true` → 422 `BATCH_NOT_CONFIRMED`，**零任务写入**（P3 generate-all 服务端闸门先例）；
   - shotIds 非空、去重、上限 100（`BATCH_TOO_LARGE`）、每个都须在项目中（404 附缺失列表）；
   - 画幅语义与 M1 单镜头完全一致（契约支持直通 / 无 decision 409 / 有 decision 全批采用）；
   - **每镜头 motionPrompt 自动组装**：`subjectScene = shot.optimizedPrompt || shot.description`（两者皆空 → 422 `SHOTS_MISSING_PROMPT` 附 shotId 列表，**整批拒绝**零写入）；`cameraMove = shot.cameraPromptUsed`（可空）；其余段留空；
   - 逐镜头 `submitVideoTask`（串行），每条独立快照（快照结构同 M1，seed 每条独立随机）；某条 provider 创建失败 → **该条任务行保留 failed 审计，继续后续镜头**，最终返回 `{ submitted: [{shotId, taskId}], failed: [{shotId, error}] }`（201，只要至少一条提交成功；全失败 502）。

## 五、前端 `VideoLabPanel.tsx` 扩展（M1 结构保留）

1. **Take 列表**：选中镜头下方增加"历史 Take"区（GET shots/:id/tasks）：每行 = 状态徽标（沿用 M1 五态文案）/ 创建时间 / seed / 时长；`completed + local_path` 的行提供"并排预览"复选与"设为定稿"按钮；`download_error` 行红标显示错误、无定稿按钮。
2. **并排预览**：勾选 ≤3 个已落盘 take → 并排 `<video>`（muted、循环、各自带 seed/时间标注）；这是对比视图，**不复用 AnimaticPlayer**（它是顺播语义）。
3. **定稿**：`设为定稿` → PUT final-video；成功后该行金色"定稿"徽标、其余行"设为定稿"可换选；已定稿 take 提供"取消定稿"（PUT null）。422 各 code 的错误文案逐一映射（尤其 TAKE_NOT_DOWNLOADED 要附 download_error）。
4. **批量生成**：镜头多选列表（默认勾选"无定稿视频"的镜头）+ 参数区沿用项目级枚举 → 点"批量生成"弹**成本闸门确认层（硬规则 C，三数字分开不得合并）**：
   ```text
   镜头数量：N
   预计生成任务：N
   输出视频总时长：N × durationSec 秒        ← 精确值
   预计任务运行时间：约 N × 70 秒(串行,依 Provider 队列浮动,仅供参考)   ← 估算,来源=M1 真机单条 68s
   Provider：Agnes Video v2.0
   预计费用：费用由 Provider 实际计费
   ```
   确认 → `confirmed: true` 提交；409 画幅复用 M1 三选层；结果区列 submitted/failed 明细，逐条可跳转到对应镜头的 Take 列表。
5. 无 M3 功能入口（导出/打包/重试下载）。

## 六、Animatic 混播数据面

1. `src/components/animaticPlaylist.ts`：`buildAnimaticPlaylist(shots, finalVideos?)` 增加可选第二参
   `finalVideos?: Record<string, { videoUrl: string; durationSec: number; taskId: string }>`：
   命中 shotId → item 填 `videoUrl` + `finalVideoTaskId`，**durationSec 用 finalVideos 的值覆盖 shot.durationSec**（M1 备忘②：视频实际时长优先，防兜底提前切镜）；未命中 → 行为与现状完全一致；**legacy `shot.videoUrl` 依旧拒传**。
2. AnimaticPlayer 组件不改（混播分支 M0 已就绪）；App.tsx 接线（fetch final-videos + 传参）归 CC。

## 七、测试与验收

- 模块测试（deps 全 stub）：
  - Take 列表：排序、项目/shot 404；
  - 定稿硬规则 B 矩阵：五个 code 逐一触发 + 成功写指针 + null 取消删字段 + mutateDb 未被调用于任何 422 路径；
  - final-videos：normalized_seconds 优先、num_frames/frame_rate 回退、悬空指针进 degraded 不进 finalVideos、硬规则 B 复查；
  - 批量：confirmed 闸门零调用 submitVideoTask、上限/缺 shot/缺 prompt 源整批拒绝、409 画幅、部分失败继续且返回明细、每条快照独立 seed；
  - playlist：finalVideos 命中/未命中/durationSec 覆盖/legacy videoUrl 仍拒传。
- `npm run lint` + `npm run build` + 全模块测试全过（46/46 + 新增）。
- 真机（CC 执行）：真实 Agnes 批量 2 镜（含成本闸门确认）→ Take 列表 → 定稿 → Animatic 混播（定稿镜头播视频、其余播图）→ 快照与指针落库核对。
- 证据：`docs/ui-redesign/tasks/evidence/video-lab-m2-acceptance.md`（含定稿 422 矩阵的逐 code 复现记录）。

## 八、边界（违反即返工）

- **允许改动**：`server/modules/video-lab/**`、`src/components/VideoLabPanel.tsx`、`src/components/animaticPlaylist.ts` 及其测试、`src/types.ts` 仅追加 `finalVideoTaskId?` 一行、证据文档——此外零改动；
- **禁碰**：server.ts、App.tsx、index.css、router.ts、main.tsx、AnimaticPlayer.tsx、其他 server/modules/（style-contract 只读 import 例外）——CC deps 回调与 App 接线等你交付后统一做；
- 不建表、不改 video_tasks schema、不加 npm 依赖；正式 db/uploads 零污染、真实 provider 计费调用零发生（验收全 stub）；
- animaticPlaylist 升级必须向后兼容（单参调用行为不变——现有 7 测试原样通过）；
- 提交前缀 `feat(video-lab): ...`，不 push，完成通知 CC。

## 九、CC 接线备忘（非 Codex 范围）

server.ts：register deps 增四项实现（mutateDb 复用既有、listVideoTasksByShot=prepared 查询、getVideoTask=videoTaskRow、isLocalVideoReadable=UPLOADS_DIR 解析+存在可读校验，注意路径穿越防护对齐 export-deck getLocalPath 语义）；App.tsx：交付步 Animatic 打开前 fetch final-videos 传入 buildAnimaticPlaylist（items 仍走 useMemo 稳定化）。真机回归含：M1 单镜头路径不回归、直调 POST /api/video-tasks 不回归。
