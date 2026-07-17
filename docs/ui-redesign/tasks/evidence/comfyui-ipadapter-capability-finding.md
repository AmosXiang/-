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
