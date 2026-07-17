# ComfyUI 风格锚点节点映射调研（P1-B 前置 · CC 真机）

日期：2026-07-17
执行：CC，真实 ComfyUI（8001，运行中）
方法：`/object_info`（1004 节点类型）+ 现有工作流预设结构 + 路由/生成路径代码核对

## 一句话结论

**没有一个统一的风格锚点机制能覆盖全部 ComfyUI 镜头。** 干净的风格分权重节点（`easy ipadapterStyleComposition`）**只支持 SDXL**；而进 ComfyUI 的镜头（master + 含人物，路由规则决定）用的是 **Flux2**（klein），Flux2 的风格参考只有 `StyleModelApply`（Redux），其"只取风格不抄构图"的保真度**未验证，与 Agnes referenceImages 同一风险类**。→ P1-B 需用户在模型族路线上拍板，不能直接写。

## 节点可用性（均已安装）

- **IPAdapter**（ComfyUI-Easy-Use 包装 IPAdapter-plus，**SDXL/SD1.5 专用**）：`easy ipadapterApply/ADV`、**`easy ipadapterStyleComposition`**（`weight_style` / `weight_composition` 分权重——真风格锚点，但仅 SDXL）、`easy ipadapterApplyFaceIDKolors`（身份）等。
- **PuLID**：`ApplyPuLIDFlux2`（Flux2 身份）、`easy pulIDApply/ADV`、`PuLIDModelLoader/InsightFaceLoader/EVACLIPLoader`。
- **Flux 风格/参考**：`StyleModelApply` + `StyleModelLoader`（Flux Redux 风格参考）、`ReferenceLatent` + `FluxKontextMultiReferenceLatentMethod`（Flux Kontext 图像/内容参考）。
- InstantID、ControlNet、CLIPVision 齐备。

## 关键约束：模型族碎片化

- **进 ComfyUI 的镜头 = master + 含人物**（路由 `master_frame_local` / `has_character_local` → comfyui_local；空镜 → Agnes，不进 ComfyUI）。
- 含人物镜走 `02_klein_pulid_identity`（api.json 实测 16 节点）= **Flux2**：UNETLoader → `ApplyPuLIDFlux2` → KSampler，已含 `ReferenceLatent`（Flux 原生内容参考）。
- 非人物 shot 默认走 `buildDefaultComfyWorkflow`（server.ts:3776）= 纯 checkpoint SDXL 工作流（CheckpointLoaderSimple，当前 `sd_xl_base_1.0`），除非加载了自定义 klein 工作流。
- 即"master/人物 = Flux2，非人物默认 = SDXL"——**同一 ComfyUI 内本就多族并存**（正是用户所述"同 provider 内 checkpoint/工作流漂移"）。

## 各族的风格锚点可行性

| 模型族 | 干净风格锚点 | 身份 | 共存 |
|---|---|---|---|
| **SDXL** | ✅ `easy ipadapterStyleComposition`（风格/构图分权重，现成） | IPAdapter-FaceID / InstantID（弱于 PuLID-Flux2） | model 链可串 |
| **Flux2（klein，交付线主力）** | ⚠️ 仅 `StyleModelApply`（Redux）——**风格纯度未验证，Redux 惯于抄构图，须 A/B** | ✅ `ApplyPuLIDFlux2`（强） | Redux(conditioning) + PuLID(model) 注入点不同可串，但叠加 + 既有 ReferenceLatent 的相互干扰未验证 |

## P1-B 的三条路线（需用户拍板）

- **(a) 全镜统一 SDXL**：用 `ipadapterStyleComposition` 做真风格锚点 + IPAdapter-FaceID/InstantID 做身份。代价=放弃 klein/Flux2 画质、身份一致性弱化。
- **(b) 留 Flux2 + Redux**：`StyleModelApply` 做风格锚点。**前置=一次 Redux A/B**（同 Agnes 那样：冷暗锚图 + 反差 prompt，判是否只迁风格）；再验 Redux+PuLID 共存需真实建 workflow 跑。风险=Redux 可能同样抄构图。
- **(c) 分层折中**：风格锚点只上 master/establishing 镜（无 PuLID 冲突），人物镜靠 PuLID + prompt overlay + 人工复核。最省、最稳，但人物镜风格统一仍弱。

## 与 Agnes 结论合并的全局图

- 空镜（Agnes）：referenceImages 已验为主体/构图参考，锚图不可用 → 只剩 prompt overlay（P0 已上）。
- ComfyUI 镜（Flux2 为主）：干净风格节点用不了，Redux 未验 → 同样悬而未决。
- **因此"交付级混合 provider 严格风格统一"目前无现成技术路径**；用户原定"审阅稿混跑、交付稿以 ComfyUI 配方为准 + 人工复核 + 漂移重生"的策略是当前唯一稳妥落法。P1-B 的价值取决于用户在 (a)/(b)/(c) 的选择。

## 待用户拍板后 CC 下一步

选 (b) → 跑 Flux Redux A/B（本轮未跑，ComfyUI 在线可立即做）；选 (a) → 建 SDXL styleComposition+FaceID 试跑；选 (c) → 直接进 P1-A 资产层 + master 镜注入小样。

---

## 补记：(b) Flux Redux A/B 在资产门证伪（2026-07-17，用户批准跑 b 后）

用户批准把 (b) 当一次性证伪实验跑（验收：3 seed 全不抄构图 / strength 梯度 / 带·不带 PuLID 两轮 / 真图作证）。**执行前先查 Redux 所需模型文件——直接短路：**

- `StyleModelLoader` 可用 style_model = **`[]`（空，无 Redux 风格模型）**
- `CLIPVisionLoader` 可用 clip_vision = **`[]`（空，无 CLIP vision 模型）**
- `StyleModelApply` 硬依赖 `style_model` + `clip_vision_output` 两者 → **无法实例化，A/B 无法运行**。

叠加架构疑点：Redux 是 **Flux.1-dev** 机制，本管线是 **Flux.2-klein**（`flux-2-klein-base-4b` / `flux-2-klein-4b-fp8`，见 UNETLoader 枚举），Flux.2 是否有兼容 Redux 权重存疑——即便下载 flux1-redux-dev + sigclip，也可能架构不匹配。

**判定：(b) 以"资产不具备 + 架构存疑"证伪，不进入生成测试**（省下 3×2 组真机生成）。按用户预设规则 → **落 (c)，不考虑 (a)**。
若用户仍想验 (b)：需先自行安装 Flux.2 兼容的 Redux 风格模型 + CLIP vision（CC 不擅自下载 ~2GB+ 且大概率架构不匹配的权重）；装好且枚举非空后 CC 可立即跑上述 A/B。

## 最终落地（当前证据下）

**P1-B = (c) 分层折中**，与用户既定交付策略同构：
- 风格锚点只上 master/establishing 镜（无 PuLID 冲突的镜头），机制待定（Flux.2 无 Redux、SDXL 有 ipadapterStyleComposition 但 master 镜多为 Flux.2）——实际 master 镜若为 Flux.2 亦无干净风格锚点，故 master 镜风格统一同样退化为 prompt overlay + 人工。
- 人物镜：PuLID 身份 + prompt overlay + 人工复核 + 漂移镜用批准配方重生。
- 空镜（Agnes）：prompt overlay（P0 已上）。
- **净结论：全三通道的"图像级风格锚点"当前均不具备（Agnes=抄内容、Flux.2=无 Redux 资产、干净 IPAdapter=SDXL 专用与 Flux.2 管线错配）。风格统一当前只能靠 P0 的文本 overlay 统一 + 人工复核 + 漂移重生。图像级锚点是未来项，前置=引入 Flux.2 兼容的风格参考权重或统一到 SDXL，均属较大决策。**
