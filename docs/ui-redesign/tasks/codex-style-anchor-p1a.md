# 任务书（Codex）：风格锚图与配方指纹 P1-A · 复核基准 + 溯源地基（v2，注入线已判死后重写）

> 全文直接粘贴给 Codex。上下文自包含。
> **重要背景变更（本包 v1→v2 的根因）**：原 P1-A 把风格锚图定位为"未来 P1-B 图像级注入的前置资产"。该前提**已被四条独立证据线判死**（证据 `evidence/agnes-referenceimages-ab-finding.md`、`evidence/comfyui-ipadapter-capability-finding.md`）：
> - Agnes `referenceImages`＝主体/构图参考（实测抄内容，非风格）；
> - Flux Redux＝无资产 + Flux.1 机制与本管线 Flux.2-klein 架构错配；
> - SDXL `ipadapterStyleComposition`＝干净但与 Flux.2 管线族错配；
> - Flux.2 原生 `ReferenceLatent`＝"混合两图"失败类，且 Flux.2 **根本没有风格/构图分权重的概念**。
> **结论：图像级风格锚点在当前技术栈"缺机制"而非"缺资产"，架构性不可得，除非整族切换或 BFL 出 Flux.2 原生风格适配器。P1-B（图像级注入）永久关闭直到该前提改变。**
> **因此本包 v2 重定义**：风格统一由「P0 文本 overlay（已上）＋人工复核＋漂移镜按批准配方重生」承担（四证据线背书）。本包做两件让这套策略**可落地、可追责、可被未来 P2 定稿门执行**的地基：①风格锚图＝**带版本的人工复核基准（reference-of-record）**，不是注入输入；②**配方指纹（recipe fingerprint）**＝每镜生成时的 provider＋模型＋工作流＋关键强度＋契约版本＋锚图版本的结构化记录＋稳定哈希。
> 分工（Codex 主导，沿用 P0/离线入队包先例）：coding＋deps 形状＋server.ts 接线（仅列明热区）＋验证＋提交＋隔离起服接线自验；CC 只逐行 review＋真机。
> 基线 `feature/camera-derive@f1740f5`。分支：`git worktree add -b feat/style-anchor-p1a ../wt-style-anchor f1740f5`（强制独立 worktree）。

## 一、范围拍板（越界即返工）

**做**：
1. 项目级"风格锚图"资产（独立字段，**绝不复用人物母版**）：设置/清除/读取＋版本号（内容变即 +1）＋可选"目标风格说明"短文本；定位＝人工复核基准，UI 明示"用于人工比对，不注入生成"。
2. **配方指纹**：每次生成成功时，把该镜的生成配方落成结构化字段＋稳定哈希，写进 shot JSON 与审计（两条管线——Agnes 与 ComfyUI——都要，见 §四）。这是"批准配方/漂移重生/P2 定稿门"的唯一事实源。
3. StyleBundle（P0 已建）与审计/响应扩展，承载锚图版本与配方指纹（**仅记录，永不注入 prompt/conditioning**）。
4. 前端：风格设定步骤加"风格锚图"卡片（上传/预览/清除，诚实标注"复核基准，不参与生成"）＋镜头检查器只读展示该镜配方指纹与"是否匹配当前锚图版本/契约版本"的标记（纯展示，不做拦截——拦截是 P2）。

**不做（红线，违反即整包返工）**：
- **任何把锚图或任何图像喂进 provider 的行为**（referenceImages 传参、IPAdapter/Redux/ReferenceLatent 节点、prompt 拼接图像描述）——图像级注入已判死，本包零涉及。
- 定稿门的**拦截/阻断逻辑**（P2 独立包）——本包只产出指纹与展示标记，不改定稿可否的判定。
- ComfyUI 生成路径的 workflow 结构改动、角色/PuLID 任何改动、Agnes 视频链路。

## 二、数据模型（零迁移，铁律 6：Shot/项目可选 JSON 字段，不建表不改 schema）

项目 JSON（store `generated_scripts`）追加可选：
```ts
styleAnchor?: {
  imageUrl: string;          // /uploads/style-anchors/... 本地相对路径
  version: number;           // 从 1 起；imageUrl 内容变化 +1，相同幂等不变
  note?: string;             // 可选目标风格说明（人工复核用）
  updatedAt: string;
};
```
Shot JSON 追加可选（与 P0 的 `gen_style_contract_version` 同机制同位置，成功写/缺席清）：
```ts
gen_style_anchor_version?: number;   // 生成时刻的锚图版本（无锚图不写）
gen_recipe?: {                       // 配方指纹（结构化 + 哈希）
  fingerprint: string;               // 下述规范化字段的稳定哈希（sha1，前 16 hex）
  provider: string;                  // agnes | comfyui_local | ...
  model: string;                     // Agnes 模型名 / ComfyUI checkpoint 或 UNET
  workflowPresetId: string | null;   // ComfyUI 预设 id；Agnes 为 null
  styleContractVersion: number;
  styleAnchorVersion: number | null;
  params: Record<string, number | string>;  // 关键强度：宽高/steps/cfg/loraStrength/motionStrength 等，按可得填，缺省不塞占位
};
```
- 版本规则：`styleAnchor.imageUrl` 内容变 → version+1；相同 → 不变；清除 → delete 字段（不留历史，同"定稿指针干净删除"先例）。
- 锚图落 `uploads/style-anchors/<projectId>-<version>.<ext>`，复用现有上传中间件与路径穿越防护语义。

## 三、配方指纹规范化（可测纯函数，硬要求）

- 新纯函数（组织你定，参考 `styleBundle.ts` 同级）`buildRecipeFingerprint(input) → gen_recipe`：**先规范化再哈希**——字段按固定键序、数值定精度（如 loraStrength 保留 2 位、宽高取整）、null 与缺省区分清楚，保证**同配方跨进程/跨时间哈希稳定**（这是漂移判定与 P2 门的地基，哈希不稳定则整套失效）。
- 哈希只覆盖"决定画风的配方字段"，**不含** prompt 文本、seed、requestId、时间戳（这些变了不算配方漂移）。哪些字段进哈希在函数里注释写死并单测锁定。
- Agnes 与 ComfyUI 两条管线各自组装 input，但**共用同一 `buildRecipeFingerprint`**，保证跨 provider 可比（"同配方"判定不因 provider 分叉而漂）。

## 四、两管线接线（server.ts 热区 + imageGen 模块 + ComfyUI 任务落库）

- **imageGen 模块（Agnes 路径，常规可改区）**：P0 已有 `resolveStyleContext` 回调；其返回值追加 `styleAnchorUrl` / `styleAnchorVersion`（无则 null）。成功生成时组装 Agnes 侧 recipe input（provider=agnes、model=实际请求模型、preset=null、契约/锚图版本、params=宽高等），调 `buildRecipeFingerprint`，写 shot JSON `gen_style_anchor_version` / `gen_recipe`，并进审计 raw_meta 摘要与响应体。
- **server.ts 热区（仅两处，用既有 import 组装，不加新 import、不碰他处）**：
  1. `registerImageGenRouting({...})` 调用点：`resolveStyleContext` 回调补 `styleAnchor*` 字段（从项目 `styleAnchor` 读）。
  2. **ComfyUI 任务落库处**（`prepareComfyTaskData` 或任务 INSERT 邻近，约 L7202-7444 一带）：把该镜配方（provider=comfyui_local、model=checkpoint/UNET、workflowPresetId、契约/锚图版本、params=宽高/steps/cfg/loraStrength 等既有变量）经**同一 `buildRecipeFingerprint`** 写入该 shot JSON 的 `gen_recipe` / `gen_style_anchor_version`。**只加写入，不改 workflow 结构、不改生成行为**。
- **风格锚图后端模块** `server/modules/style-anchor/`（照抄 scene-reference/export-deck 结构；server.ts 1 import + 1 register）：`PUT /api/projects/:projectId/style-anchor`（落盘+version+mutateDb）、`DELETE`（删字段+可选 unlink，路径穿越防护）；GET 并入项目读取。deps＝mutateDb/readDb/uploadsDir。

## 五、前端（`src/App.tsx` 或风格设定/检查器组件，仅列明两处）

1. 风格设定第①步「项目风格 / Style Contract」区旁：独立「风格锚图」卡片——上传/预览/清除/目标风格说明输入；文案明确「**人工复核基准：用于比对分镜是否贴合目标风格；当前技术栈下不作图像注入（见风格调研结论）**」。不动角色母版区、不动 provider 选择器。
2. 镜头检查器：只读展示该镜 `gen_recipe`（provider/model/preset/关键强度）＋两枚状态标记「契约版本 匹配/落后当前」「锚图版本 匹配/落后当前」——**纯展示，不拦截**（拦截是 P2）。

## 六、验证与验收（可以严）

- **配方指纹纯函数测试**：同配方跨两次调用哈希一致；prompt/seed/时间戳变化哈希不变；任一决定画风字段（model/preset/宽高/loraStrength/契约或锚图版本）变化哈希必变；null 与缺省不混淆；键序无关（乱序输入同哈希）。
- **风格锚图模块测试**（mutateDb/readDb stub）：set 落盘+version 从 1、同图幂等、换图 +1、clear 删字段、路径穿越防护、GET 随项目返回。
- **Agnes 路径集成测试**：成功生成写 `gen_recipe`＋`gen_style_anchor_version`；无锚图 → 锚图版本不写但 recipe 仍写；`composeAgnesPrompt` 输出与 P0 逐字一致（**回归断言：锚图/指纹绝不进 prompt**）；forceProvider/旧管线不受影响。
- **ComfyUI 落库测试**：任务落库写 recipe 且与 Agnes 用同一哈希函数（构造同规范化输入 → 同 provider 无关字段部分哈希可比）；**workflow 结构/生成行为零变化**（快照对照）。
- **接线自验（Codex，沿用 P0）**：隔离起服（临时库/uploads/假 Agnes）——设锚图→项目 JSON 有版本；Agnes 生成→shot JSON 落 recipe＋锚图版本，且产图 prompt 无锚图/无 referenceImages 传参、生成图不受锚图影响（对照）；两次同配方生成 recipe.fingerprint 相同、改 loraStrength 后不同。
- `npm run lint` + `npm run build` + 全模块测试（当前基线数 + 新增，不回归）+ imageGen 测试（不回归）。
- **诚实边界**：本包不宣称任何"风格统一效果"——只交付资产/指纹/展示地基；风格是否统一仍靠人工复核。证据须显式写明"零图像注入"经回归断言与自验双重确认。
- 证据：`docs/ui-redesign/tasks/evidence/style-anchor-p1a-acceptance.md`。

## 七、边界（违反即返工）

- **允许改动**：新增 `server/modules/style-anchor/**`、`server/providers/imageGen/**` 及其测试、server.ts **仅限 §四两处热区（registerImageGenRouting 调用点 + ComfyUI 任务落库写指纹处）＋ register 新模块 1 行 import/1 行 register**、`src/App.tsx`（或风格设定/检查器组件）仅 §五两处、证据文档。
- **禁碰**：server.ts 其余全部（含 ComfyUI workflow 构建/生成逻辑、Agnes 视频链路、runtime 管理、video-lab/export-deck 注册区）、其余 server/modules/**、角色/PuLID、config/**、index.css。
- **绝对红线（永久）**：**零图像级注入**。任何把 styleAnchor 或任何图像喂给 provider（referenceImages/IPAdapter/Redux/ReferenceLatent/prompt 图描述）即越界，整包返工——该能力已被架构性判死，本包纯记录/展示。
- **哈希稳定性红线**：`buildRecipeFingerprint` 若跨进程不稳定（含 Object 键序、浮点格式化、Date 混入），视为核心缺陷返工——它是漂移判定与 P2 门的唯一地基。
- 不建表、不改 schema、不加依赖；正式 db/uploads 零污染；真实 provider 计费零发生。提交前缀 `feat(style-anchor): ...`，不 push，完成通知 CC。

## 八、CC 后续（非 Codex 范围）

- 逐行 review：两处 server.ts 热区越界审计、`composeAgnesPrompt` 零注入回归、哈希稳定性（跨进程实测同配方同哈希）、ComfyUI 落库不改生成行为。
- 真机：设/换/清锚图版本正确；真实 Agnes 空镜生成写 recipe＋锚图版本、产图不受锚图影响（对照组）；真实 ComfyUI 人物镜/master 镜落库 recipe 与 Agnes 可比；检查器版本落后标记正确。
- **P2 定稿门任务书由 CC 后续另出**：消费本包的 `gen_recipe` 指纹＋契约/锚图版本＋人工确认，做"同配方＋同版本＋实物校验＋人工过"的定稿判定（拦截逻辑），CLIP/色彩相似度仅作离群警告。本包只铺地基不做拦截。
