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

---

## 补记二：Flux.2 原生参考语义调研——「未来项」改判为「架构性不可得」（2026-07-17，用户调研 + CC 归档）

用户就"Flux.2-klein 有没有官方风格参考方案"查完，结论把上面的"未来项"直接定案：

- **Flux.2 没有"风格权重"这个概念**：FLUX.2 klein 4B/9B 是统一的 rectified-flow transformer，把文生图与多参考编辑**合一在同一模型**（编辑能力含风格变换/语义编辑/对象替换/多参考合成）。Klein 的"参考"**就是工作流里已有的 `ReferenceLatent`**——资产早在、无需下模型；但它**没有 `weight_style` / `weight_composition` 分权重旋钮**，`ipadapterStyleComposition` 那种"只取风格不取构图"的干净解耦在 Flux.2 生态**无对应物**。
- **第四次撞同一堵墙（新增证据）**：社区实践（Krita-AI-Diffusion 用户）报告 Flux.2 做不了图到图风格迁移——能"1 图 + 文字定风格"或"纯文字 + 参考图定风格"，但"拿 A 图迁 B 图风格"结果是**两图被混合**（与问者原话"从图2迁移风格→两图糅合"一致）。即 `ReferenceLatent` 属"混合两图"失败类。
- **多参考可靠性更差**：Klein 喂多张参考图结果不一致（衣对脸变 / 脸近背漂），3 张参考仍有明显错误，模型保一元素丢另一元素——人物镜本已挂 PuLID 身份线，再叠风格锚图正踩此"互相打架"区间（印证早先 Redux+PuLID 共存担忧，换成 ReferenceLatent 同理）。

**四机制汇总（全部撞同一墙）**：

| 机制 | 失败方式 | 性质 |
|---|---|---|
| Agnes referenceImages | 抄主体构图（实测） | 语义=主体参考 |
| Flux Redux (StyleModelApply) | 无资产 + Flux.1 机制架构错配（证伪） | 资产+架构 |
| SDXL ipadapterStyleComposition | 干净，但与 Flux.2 管线错配 | 族错配 |
| Flux.2 原生 ReferenceLatent | 混合两图（社区实测） | 语义=编辑合成，无解耦 |

- **两条未堵死但都不建议动的缝（记录不推进）**：①多参考在 **9B** 上明显更好 + 社区节点 Flux Klein Ref Grid（4 图 2×2 网格作 reference latent）——解决"多图打架"不解决"风格/构图解耦"，对本需求无用；②**BFL 官方 API** 有开源权重没有的高级多参考编辑——违背本地化前提且引入不可复现 provider，不值得。
- **架构性定案**：图像级风格锚点在当前技术栈**不是"缺资产"是"缺机制"**。Flux.2 参考=编辑合成，天然不解耦；干净解耦（IPAdapter StyleComposition）是 SDXL 专属。要真正拿到图像级锚点，前置=**整族切换**——而那要拿画质 + 已跑通的 PuLID 身份线去换，方向依旧反。**故 P1-B = (c) 不仅是当前唯一稳妥落法，且在可预见将来都是正确落法，直到 BFL 出 Flux.2 原生风格适配器为止。**
- **零成本可选实测（不现在做）**：`ReferenceLatent` 已在工作流、无需下模型，将来可用本文的 A/B 框架（强风格弱内容锚图 + 反差 prompt + 3 seed）把社区报告变成自测证据。但社区证据已足够强，且无权重旋钮通过与否都改不了 (c) 决策——等它有决策价值再跑。

**归档结论：本调研线关闭。P1-B = (c) 锁定；图像级锚点标记为「架构性不可得，除非换族/BFL 原生方案」。风格统一由 P0 文本 overlay + 人工复核 + 漂移镜按批准配方重生承担，四条独立证据线背书。下一步价值落在 P2 定稿门（查配方+版本+人工，非 provider）+ P1-A 的配方指纹地基。**
