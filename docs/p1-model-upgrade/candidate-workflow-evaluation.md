# P1 Model Upgrade 候选工作流评估

评估日期：2026-07-03  
目标硬件：NVIDIA GeForce RTX 5070 12GB  
阶段：只评估和定义导入框架，不安装 custom nodes、不下载模型、不执行真实生成。

## 结论表

| 候选 | 固定来源 | 用途 | Custom nodes | 模型文件及大小 | RTX 5070 12GB | API workflow | Manifest 映射 | 风险 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Comfy-Org/workflow_templates — Flux.2 Klein 4B | https://github.com/Comfy-Org/workflow_templates<br>`94a136cbc86e7ad631f9d05ee736be20cf810cf7`<br>`templates/image_flux2_klein_text_to_image.json` | 分镜、角色母版、风格基线 | 无；使用 ComfyUI 原生 Flux.2 节点 | `flux-2-klein-base-4b.safetensors` 7.75GB；`qwen_3_4b.safetensors` 约8GB（BF16，导入前锁定具体文件并复核）；`flux2-vae.safetensors` 大小需在模型 revision 固定后记录 | **有条件适配**。1024px、batch=1并启用模型/文本编码器卸载时预计峰值10–12GB以上；三套权重不可同时常驻显存。优先评估FP8或顺序卸载 | 来源是UI/subgraph工作流，不是可直接提交的API JSON；在目标ComfyUI加载后可导出API格式 | 可以；prompt/seed/width/height/output均为确定的原生节点输入 | 中 |
| comfyanonymous/ComfyUI_examples — Flux 2 examples | https://github.com/comfyanonymous/ComfyUI_examples<br>`f9431bb000ce792094ff345446e22cac1ea6cef3`<br>`flux2/` | 官方结构参考、Flux.2基础验证 | 选定的基础示例通常无custom nodes；必须按具体PNG元数据复核 | 随选定示例变化；4B Klein可复用上一行模型栈，其他Flux.2变体不得混为同一预设 | **仅参考，暂不作生产候选**。仓库目录包含多种模型/精度，未锁定具体示例前无法给出可信显存上限 | 工作流嵌入PNG元数据；需先加载到ComfyUI，再导出API格式 | 选定单个具体示例后可以 | 中 |
| iFayens/ComfyUI-PuLID-Flux2 v0.6.2 | https://github.com/iFayens/ComfyUI-PuLID-Flux2<br>`cefdff87100238d2c06833e93d34ddb71f1048f0`<br>`workflows/` | 角色身份锁定、带角色分镜、三视图身份一致性 | `iFayens/ComfyUI-PuLID-Flux2` 固定到同一commit；节点包括 `PuLIDEVACLIPLoader`、`PuLIDInsightFaceLoader`、`PuLIDModelLoader`、`ApplyPuLIDFlux2` | Klein 4B基础栈；`pulid_flux2_klein_v2.safetensors`（上游未在仓库文档提供稳定字节数，导入前必须固定HF revision并记录SHA256/大小）；AntelopeV2约428MB；EVA-CLIP约800MB | **高压条件适配**。1024px无强制卸载预计11–14GB以上；首测应为768px、batch=1并顺序CPU卸载。当前项目已存在02预设，必须先做同commit对比，不能覆盖 | 自定义节点可在ComfyUI队列/API中执行；上游UI工作流仍需导出并验证API格式 | 可以；除通用参数外必须映射reference image和strength | 高 |
| cubiq/ComfyUI_IPAdapter_plus — SDXL Style/Composition | https://github.com/cubiq/ComfyUI_IPAdapter_plus<br>`a0f451a5113cf9becb0847b92884cb10cbdec0ef`<br>`examples/ipadapter_style_composition.json` | 风格参考、构图参考、角色视觉参考 | `cubiq/ComfyUI_IPAdapter_plus` 固定到该commit；主要节点 `IPAdapterUnifiedLoader`、`IPAdapterAdvanced`、`IPAdapterStyleComposition` | `ip-adapter-plus_sdxl_vit-h.safetensors` 848MB；`CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors` 2.53GB；SDXL基础checkpoint通常6.5–7GB | **可适配但需卸载**。1024px、batch=1、FP16并启用attention/CPU offload时预计9–12GB；必须给激活张量留余量 | 自定义节点支持队列执行；示例为UI workflow，需要在目标环境导出API格式 | 可以；必须映射reference image、weight、weight type、start/end | 中高；仓库已进入maintenance-only状态 |

## 推荐接入顺序

1. **IPAdapter Plus**：先补齐参考图/风格一致性能力；依赖和映射边界清楚，但必须固定commit并接受维护模式风险。
2. **Flux.2 Klein 4B官方workflow**：无第三方节点，适合作为下一代基础分镜/角色母版候选；先验证12GB卸载策略。
3. **PuLID Flux2 v0.6.2**：只作为现有 `02_klein_pulid_identity` 的对照候选。节点、权重、输出和显存全部验证后，另开评审决定是否新增预设；本阶段不替换02。
4. **ComfyUI_examples**：只作为官方行为和节点结构参考，不直接生产接入。

## 显存估算口径

- 文件大小不是显存峰值；估算还包含文本/视觉编码器、VAE、latent、attention和采样中间张量。
- 结论以1024px、batch=1为主要口径。PuLID首测降至768px。
- 标注“需复核”的模型禁止进入 `requiredModels` 的可安装状态；导入时必须补齐固定revision、字节数和SHA256。
- 最终适配结论只能由目标RTX 5070上的单工作流峰值记录确认，本阶段不跑生成。

## 本阶段保护线

- 不修改或替换 `workflows/character/01`、`02`、`03`、`04`。
- 不执行 `git clone`，不写入ComfyUI `custom_nodes`，不修改ComfyUI本体。
- 不修改数据库结构，不改变批量生成、角色一致性或现有预设加载逻辑。

