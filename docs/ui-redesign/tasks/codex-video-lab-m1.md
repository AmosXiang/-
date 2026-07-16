# 任务书（Codex）：Video Lab M1 单镜头视频生成

> 全文直接粘贴给 Codex。上下文自包含。
> 方案依据：`docs/ui-redesign/video-lab-plan-2026-07-15.md` §三/§五A/§六（本任务书与方案冲突时以方案为准）。
> 分工：本包归你（coding+验证+提交）；CC 负责 server.ts 接线（deps 提取、迁移、register）、App.tsx 挂载、review、真机回归。
> **前置（三项全满足才可分发，2026-07-16 用户核对确立）**：
> ① WP-Animatic 已合入主线（`3dc2777`，结果预览复用其 AnimaticPlayer）——**已满足✓**；
> ② 主工作区改动已落定（`90f64fd` feat(studio)，用户真机复核 PASS，六文件入库、工作区干净）——**已满足✓**；
> ③ Agnes capability 契约已按代码可证事实修订（v1.1，见 §二）——**已满足✓**。
> 基线：`c56ae25`（含 Animatic 接线与播放器计时加固；CC 于 2026-07-16 核验：lint 净 + 模块测试 37/37 + playlist 7/7 + 真机 74 镜项目播放验证）。
> 分发状态：**可立即分发**。
> 分支：`git worktree add -b feat/video-lab-m1 ../wt-video-lab-m1 c56ae25`（强制独立 worktree）。

## 一、M1 范围拍板（用户定，越界即返工）

**做**：`server/modules/video-lab/` 模块、Provider capability 静态声明、单镜头生成、三模式按 capability 显示、画幅继承与不兼容提示、独立 motionPrompt、参数快照、结果预览复用 AnimaticPlayer。
**不做（留 M2/M3）**：多 Take 对比、`finalVideoTaskId` 定稿、批量生成、成本闸门、按 shot 查询历史、ZIP 导出。UI 不留这些功能的半成品入口。

## 二、Capability 静态声明（`server/modules/video-lab/capability.ts`）

```ts
export type GenerationModes = { textToVideo: boolean; imageToVideo: boolean; firstLastFrame: boolean };
export type VideoProviderCapability = {
  id: string; label: string;
  supportedModes: GenerationModes;
  durations: number[];        // 秒，枚举
  resolutions: string[];
  aspectRatios: string[];     // 如 '16:9' | '9:16' | '1:1'
  fpsOptions: number[];
  supportsAudio: boolean;
  supportsNativeCameraControl: boolean;
};
```

- **M1 只声明 agnes 一个真实 provider，数值固定为代码可证事实**（2026-07-16 用户核对拍板，禁止扩展）：

```ts
// agnes 声明值（唯一合法版本）
supportedModes: { textToVideo: true, imageToVideo: false, firstLastFrame: false },
durations: [3, 5, 10, 18],       // server.ts 既有校验枚举
resolutions: ['1152x768'],       // 既有管线请求尺寸固定值
aspectRatios: ['3:2'],           // = 1152:768 约分
fpsOptions: [24],                // 既有默认值；代码校验虽收 1–60，但无官方证据 provider 全域支持，只声明 24
supportsAudio: false, supportsNativeCameraControl: false,
```

  依据边界：**`video_tasks.normalized_size` 是 Agnes 响应后记录的结果，不是请求输入，禁止用它推导输入能力**。**禁止臆造能力**（方案 §3.1：Veo `referenceImages`≠首帧即前车之鉴）；核对不到的能力一律声明 false/空。若日后取得 Agnes 官方能力文档，扩枚举另开跟进包，不在 M1。
- Kling/Veo 本期**不声明**（管线未接 video_tasks，接入归后续）。多 provider 路径用测试内 fixture provider（三模式全开）验证校验逻辑。

## 三、后端模块 `server/modules/video-lab/`（结构照抄 camera-derive）

deps 注入（接口你定，实现 CC 提供）：

```ts
type VideoLabDeps = {
  readDb: () => any;
  submitVideoTask: (input: {
    shotId: string; provider: string; prompt: string; negativePrompt?: string;
    seed: number; numFrames: number; frameRate: number;
    generationSnapshotJson: string;
  }) => Promise<{ taskId: string }>;   // CC 从既有 POST /api/video-tasks 内部逻辑提取；
                                       // 请求尺寸由既有管线固定 1152×768，M1 不作为输入传递（快照记录固定值）
  isProviderConfigured: (providerId: string) => boolean;
};
```

错误一律 4xx + machine-readable `code`。

1. `GET /api/video-lab/providers` → `{ providers: [{ ...capability, configured }] }`（纯静态 + configured 标志）。
2. `POST /api/video-lab/shot-tasks` body：

```ts
{
  projectId: string; shotId: string; provider: string;
  mode: 'textToVideo' | 'imageToVideo' | 'firstLastFrame';
  durationSec: number; fps: number; resolution: string;
  motionPrompt: {              // 方案 §6.2 六段式，独立于 optimizedPrompt
    subjectScene: string;      // 必填非空
    action?: string; cameraMove?: string; environment?: string;
    continuity?: string; prohibitions?: string;
  };
  motionStrength: 'static' | 'natural' | 'extreme';
  aspectDecision?: { aspectRatio: string; adaptMode: 'crop' | 'letterbox' };  // 见校验 4
  seed?: number;               // 缺省随机
}
```

校验顺序（全部 422 + code，除注明外）：
   1. 项目/shot 存在（404）；provider 存在且 `configured`（`PROVIDER_NOT_CONFIGURED`）；
   2. `mode` 在该 provider `supportedModes` 中为 true → 否则 `MODE_UNSUPPORTED` + 附 supportedModes（**禁止静默降级**，方案 §6.1）；M1 实际管线只有 textToVideo（agnes），imageToVideo/firstLastFrame 请求在真实 provider 上自然被此校验拒绝；
   3. durationSec/fps/resolution 必须命中 capability 枚举（`PARAM_OUT_OF_CAPABILITY`）；
   4. **画幅继承（方案 §五A）**：项目画幅 = 风格契约 width:height 约分（契约取自 style-contract 模块导出的 `resolveEffectiveStyleContract(readDb, projectId)`，只读引用，wrap 其 PROJECT_NOT_FOUND）。契约画幅 ∈ capability.aspectRatios → 直接采用；不支持 → 若无 `aspectDecision` 返 409 `ASPECT_UNSUPPORTED` + `{ projectAspect, supportedAspectRatios }`（前端据此弹三选层）；有 `aspectDecision` 且其 aspectRatio 受支持 → 采用并记入快照（**不允许服务端擅自裁切**）。注意：M1 的 agnes 仅 3:2，多数项目契约为 9:16/16:9，**409 流程是常态路径不是边缘情况**，测试与 UI 都按主路径对待。
   5. 通过后：`assembleVideoPrompt`（纯函数）按方案 §6.2 顺序拼接非空段，motionStrength 映射为固定英文运镜强度短语注入 cameraMove 段前；`buildVideoGenerationSnapshot`（纯函数）产出完整快照（provider/mode/全部生效参数/aspect 来源[契约继承|用户 adaptMode]/motionPrompt 原文/seed/styleContractVersion）；调 `submitVideoTask` → 201 返 `{ taskId, snapshot }`。

3. 轮询/下载**不重复建设**：复用既有 `GET /api/video-tasks/:id` 与 Agnes 轮询落盘管线，模块不碰。

## 四、前端 `src/components/VideoLabPanel.tsx`

Props：`{ projectId: string; shots: Shot[] }`（挂载由 CC 接线；不写显式 `JSX.Element`）。

- 镜头下拉（序号+description 截断）→ provider 下拉（GET providers，未 configured 置灰）→ **模式 chips 仅渲染 supportedModes 为 true 的项**；
- **基础区**：时长/分辨率/FPS 全部按钮组（枚举自 capability，禁手输）、运动强度三档（静止/自然/极端）、motionPrompt 六字段（subjectScene 提供"从 optimizedPrompt 预填"按钮、cameraMove 提供"从机位指令预填"按钮=cameraPromptUsed，预填后可改）；
- **高级区（默认折叠）**：seed、negativePrompt；
- 画幅行：显示"项目画幅 X:Y（继承风格契约）"；POST 返回 409 `ASPECT_UNSUPPORTED` 时弹三选层（更换模型/裁切适配/留边适配，后两者带 aspectDecision 重发），文案照方案 §五A；无其他 provider 支持该画幅时"更换模型"置灰并注明"当前无支持 X:Y 的模型"；
- 生成后轮询 `GET /api/video-tasks/:id`（5s 间隔，pending/in_progress 显示进度，failed 显示 error），completed 且 local_path 非空 → 用 **AnimaticPlayer 单条 items** 预览结果视频（`videoUrl` 指向本地服务路径），并展示本次快照摘要（可折叠 JSON）；
- 无任何 Take 列表/定稿/批量 UI（§一不做项）。

## 五、测试与验收

- 模块测试（node:test，deps 全 stub，`submitVideoTask` 记录入参断言）：providers 端点形状与 configured 标志；校验矩阵（mode 拒绝含 fixture provider 三模式、枚举越界、agnes 上 imageToVideo 被拒）；画幅三态（契约支持直通 / 无 decision 409 附清单 / 有 decision 采用且入快照）；`assembleVideoPrompt` 段序、空段跳过、强度短语注入；快照完整性（aspect 来源标注两种）；subjectScene 空 422；
- `npm run lint` + `npm run build`；
- 真机（CC 执行，真实 Agnes key + db 副本）：单镜头 textToVideo 全链路 = 生成 → 轮询 → local_path 落盘 → AnimaticPlayer 播放 → 快照落列核对；
- 证据：`docs/ui-redesign/tasks/evidence/video-lab-m1-acceptance.md`（**必须对照 §二声明值逐项标注 server.ts 代码行出处复核**，发现声明与代码不符立即停工报 CC，不得自行改声明）。

## 六、边界（违反即返工）

- **禁碰 server.ts、App.tsx、router.ts、main.tsx、types.ts、其他 server/modules/**（style-contract 只读 import 纯函数例外）——server.ts 的 1 import + 1 register + `submitVideoTask` 提取 + `video_tasks.generation_snapshot_json` 列迁移（PRAGMA 守卫 ALTER，先例 comfyui_tasks.origin）全部由 CC 做；server.ts/App.tsx 是 CC 接线领地，你在 worktree 里改动它们必然与 CC 接线冲突；
- 不建新表；不加 npm 依赖；正式 db.sqlite、uploads 正式目录、真实 provider 计费调用零发生（你的验收全走 stub）；
- AnimaticPlayer/animaticPlaylist 只 import 不改；
- 提交前缀 `feat(video-lab): ...`，不 push，完成通知 CC。

## 七、CC 接线备忘（非 Codex 范围）

server.ts：提取 Agnes 创建内部逻辑为可注入 `submitVideoTask`（含 snapshot 列写入）+ 快照列迁移 + 1 import + 1 register；App.tsx：Video Lab 独立 tab/入口挂 VideoLabPanel（等他人未提交改动落定后再接，避免冲突）；真机回归含既有 `POST /api/video-tasks` 直调路径不回归（提取重构后行为不变）。
