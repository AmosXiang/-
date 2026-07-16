# Video Lab 产品与架构方案（v1.0 定稿 · 2026-07-15）

> 立项依据：集成计划裁决 #12（Video Lab 远期方向）+ 本轮三方定稿（用户拍板 · CC review · 2026-07-15）。
> 本文是产品与架构方案，**不含具体实现**；方案通过后由 CC 出任务书、Codex/Antigravity 执行 coding。
> 上位文档：`workflow-redesign-2026-07-14.md`、`tasks/integration-plan-2026-07-14.md`。

---

## 一、定位与边界

- **主流程终点不变**：分镜交付包（PPTX + manifest + finals/ + characters/ + scenes/ + README）仍是创作主链路的终点。
- **Video Lab 是下游独立消费者**：读 `storyboard-manifest.json`（shots 的 camera/framing/durationSec/optimizedPrompt/sceneId、scenes、角色资产），不向上游回写创作数据，不污染分镜主流程。唯一例外是 Shot 上的一个定稿指针字段（见 §四）。
- **Animatic 不属于 Video Lab**：归交付域，独立 WP 立即立项（见 §二）。

### Non-goals（本阶段明确不做）

- video-to-video 风格化
- 局部视频重绘
- 时间线剪辑器
- 完整后期合成（转场/调色/混音）

---

## 二、WP-Animatic：分镜动态预览（交付域，立即立项）

**价值**：零生成费用预览全片节奏，验证 durationSec 数据质量；同时为 Video Lab 预置播放器组件。

**输入统一为 manifest 形状的混合媒体序列**（播放器不感知来源）：

```ts
type AnimaticItem = {
  shotId: string;
  durationSec: number;
  imageUrl?: string;        // 定稿分镜图
  videoUrl?: string;        // 定稿视频（本地相对路径）
  finalVideoTaskId?: string;
};
```

**播放规则**：有定稿视频 → 播放视频；无 → 按 durationSec 展示定稿图。

**设计约束**：
1. 播放器输入是序列数据，**不绑死图片**；M1 起视频逐镜头替换进同一播放器，组件不重写。
2. 纯前端组件，不新增后端 API（数据从现有 manifest/分镜数据组装）。
3. 基础控制：播放/暂停、逐镜头跳转、当前镜头高亮联动分镜列表。

---

## 三、生成模式与 Provider Capability（静态声明，不做运行时探测）

### 3.1 三种生成模式（拍板）

作为 provider adapter 的 capability 标志位，**不是全局固定功能**：

```ts
generationModes: {
  textToVideo: boolean;      // 纯 prompt
  imageToVideo: boolean;     // 首帧/参考图 + 运动提示词
  firstLastFrame: boolean;   // 首帧 + 末帧 + 运动提示词
}
```

UI 只渲染当前 Provider 支持的模式。

**语义核对要求（写任务书前必做）**：逐 Provider 核对真实 API 语义，不得望文生义。已知示例——Veo 路径（video-generation.ts）的 `referenceImages` 是"参考图输入"（ASSET 类型），**不等同于**"首帧图生视频"；Agnes v2 现为纯 prompt 模式。每个 adapter 的 capability 声明必须以该 Provider 的 API 文档实测为准。

### 3.2 Capability 静态声明结构

```ts
type VideoProviderCapability = {
  supportedModes: GenerationModes;
  durations: number[];           // 秒，枚举
  resolutions: string[];
  aspectRatios: string[];
  fpsOptions: number[];
  supportsAudio: boolean;
  supportsNativeCameraControl: boolean;
};
```

每个 adapter 内静态 TS 声明；UI 据此动态渲染。现有代码硬编码 `durationSeconds: 8, resolution: '720p', aspectRatio: '16:9'`（video-generation.ts）即为反面教材，M1 起废除写死参数。

### 3.3 参数分层（项目级锁 / 镜头级调）

延续 P3 风格契约哲学（枚举优先、批量硬闸门、参数快照）：

| 层级 | 参数 |
|---|---|
| **项目级（锁定）** | Provider、模型、画幅比例、分辨率、FPS |
| **镜头级（开放）** | 时长、运动强度、运镜描述（motionPrompt）、首/末帧选择 |

**UI 两层**：基础模式 = 时长、运动强度、生成模式；高级设置 = Provider 特有参数（折叠，不向普通用户全量暴露）。

每次视频生成记录参数快照（复用 P3 机制语义）。

---

## 四、Task / Take 数据模型（沿用现状 + 一个指针）

### 4.1 核查结论（2026-07-15，CC 实证）

- `video_tasks` 已是真实 SQLite 表（server.ts:286），含 shot_id、provider 字段、local_path、download_error、状态索引与 `idx_video_tasks_shot_created`。
- **追加式写入已是现状**：每次生成 INSERT 唯一 id 新行，不覆盖、不删除；同一 shot 多次成功任务全部保留。**无需 Codex 修复查询语义。**
- 缺口仅一项：现有 API 只有全量列表（`GET /api/video-tasks`）与按 id 单查；**缺按 shot_id 过滤的端点**，纳入 M2 任务书（小条目）。

### 4.2 最终结构（拍板）

```text
Shot（store JSON，可选字段，零迁移）
  └─ finalVideoTaskId        // 唯一新增，定稿指针

video_tasks（既有表，不动 schema）
  ├─ Task A / B / C…         // 完整生成历史，含失败重试
```

- Shot JSON **只存定稿指针**，不存视频历史。
- 定稿语义与 P2a 故事版本定稿同构：多 Take 并排预览 → 标一个定稿 Take。
- 铁律 6（禁建表）管分镜/项目数据；video_tasks 是既有表，无冲突。

---

## 五、四条硬规则（方案级约束，任务书必须落实）

### A. 画幅继承，禁止静默裁切

视频画幅默认继承项目风格契约。Provider 不支持契约画幅时，**不允许静默裁切**，必须弹层：

```text
项目画幅：9:16
当前模型仅支持：16:9 / 1:1

选择：
○ 更换模型
○ 使用裁切适配
○ 使用留边适配
```

裁切必须由用户显式确认。

### B. 定稿视频必须已落盘

允许设置 `finalVideoTaskId` 的全部前置条件：

```text
status === 'completed'
local_path 非空
文件实际存在
文件可读取
```

导出时再次校验。临时远程 URL（Agnes `video_url` 有时效，删除后不可再生——见 docs/video-providers/agnes-video-v2.md）**不能作为定稿依据**。

### C. 批量成本闸门

批量生成确认层至少显示：

```text
镜头数量：12
预计生成任务：12
输出视频总时长：96 秒
Provider：Agnes Video v2
预计费用：可计算则显示；否则显示"费用由 Provider 实际计费"
```

**三个数字不得混淆**：输出视频总时长 ≠ 预计任务运行时间 ≠ 预计费用，分别标注。

### D. 视频默认不进 ZIP

M3 默认导出：manifest + PPTX + 定稿图 + **视频相对路径与任务信息**（manifest 内引用）。

可选项（默认关闭）：

```text
□ 同时打包定稿视频（预计增加：X GB，按实际文件求和显示）
```

---

## 六、两条补充规则

### 6.1 Provider 能力不匹配：禁止静默降级

所选生成模式不被当前 Provider 支持时（如首尾帧模式），**不允许自动降级**，必须弹层：

```text
当前模型不支持末帧控制：

○ 改为首帧图生视频
○ 更换支持首尾帧的 Provider
○ 取消
```

原则：用户设置的每个控制项，要么真实生效，要么显式告知未生效。

### 6.2 motionPrompt 独立生成，不复用 optimizedPrompt

图片描述与视频运动描述不是同一件事。视频提示词按以下结构单独组装：

```text
videoPrompt =
  画面主体与场景
+ 角色动作
+ 镜头运动
+ 环境动态
+ 连续性约束
+ 禁止变化项
```

禁止变化项示例：角色面部保持一致 / 服装不得改变 / 背景结构保持稳定 / 不要增加额外人物 / 不要切换镜头。

`optimizedPrompt` 可作为"画面主体与场景"的素材来源，但 motionPrompt 是独立字段、独立编辑。

---

## 七、里程碑与工作包拆分

```text
WP-Animatic（交付域，立即立项）
  Animatic 播放器：manifest 形状混合媒体序列，图/视频混播

Video Lab（方案通过后从 M1 立项）
  M1：单镜头视频生成
      - video-lab 后端模块（照抄 camera-derive 结构；server.ts 1 import + 1 register）
      - provider adapter capability 静态声明（含逐 Provider 语义核对）
      - 三模式 UI（capability 驱动，基础/高级两层）
      - 画幅继承检查（硬规则 A）+ 禁止静默降级（6.1）
      - motionPrompt 组装（6.2）+ 参数快照
      - 预览复用 WP-Animatic 播放器组件
  M2：多 Take、定稿、批量生成
      - 按 shot_id 查询 video_tasks 端点
      - Take 并排预览 + finalVideoTaskId 定稿（硬规则 B 校验）
      - 批量生成 + 成本闸门（硬规则 C）
  M3：视频交付与打包
      - manifest 引用视频相对路径 + 任务信息
      - 可选打包定稿视频，默认关闭（硬规则 D）
      - 导出时二次落盘校验（硬规则 B）
```

### 工程纪律（沿用 HANDOFF 铁律）

- 后端模块照抄 `server/modules/camera-derive/` 结构；server.ts 每包 1 import + 1 register。
- Shot 新字段走可选 JSON 字段，零迁移；**不建新表**（video_tasks 既有除外）。
- 外部 agent 强制 worktree；CC 出任务书 + 逐行 review + 接线兜底；合并只经集成分支。
- 组件签名不写显式 `JSX.Element`。
- 复用既有 `/api/generate-video`、`/api/video-tasks` 作为底层，video-lab 模块调用而非重写。

---

## 八、决策记录（谁拍的板）

| # | 决策 | 结论 |
|---|---|---|
| 1 | Animatic 归属 | 交付域独立 WP，立即立项，不算 Video Lab（用户拍板） |
| 2 | Video Lab 立项时机 | 方案定稿后从 M1 立项，不再等待（用户拍板） |
| 3 | 生成模式 | 三模式作 capability 标志位；video-to-video 等四项列 non-goal（用户拍板） |
| 4 | capability 机制 | 静态声明，不做运行时探测；UI 基础/高级两层（用户拍板） |
| 5 | Task/Take 模型 | 沿用 video_tasks 表 + Shot 仅存 finalVideoTaskId 指针（用户拍板；CC 核实追加式语义已是现状） |
| 6 | 硬规则 A–D | 画幅继承 / 定稿落盘校验 / 成本闸门 / 视频默认不进 ZIP（用户拍板） |
| 7 | 补充规则 | 禁止静默降级 / motionPrompt 独立（用户提出，定稿） |
