# 任务书（Codex）：风格锚图 P1-A · 资产基建与版本追踪（注入前置层）

> 全文直接粘贴给 Codex。上下文自包含。
> **本包定位（用户拍板路线的 P1 第一刀）**：P1 完整目标是双端风格锚点（Agnes referenceImages + ComfyUI IPAdapter）。但**锚图注入能力尚未验证**——Agnes referenceImages 只是"入口存在"，是否只取风格不复制主体/构图未经 A/B；ComfyUI 侧还没有 IPAdapter 节点映射。这两项是**真机调研（CC 负责，与本包并行）**，结论出来前不得写注入。
> 因此本包只做**注入前置的系统资产层**（LTX 思想：一致性=命名/版本化/自动继承）：项目级独立风格锚图的存储、版本、随 StyleBundle 继承——**不碰任何 provider 的 conditioning**。这样 A/B 一旦通过，P1-B 注入包能直接消费现成的锚图资产与版本，不悬空。
> 分工（Codex 主导，沿用 P0）：coding + deps 形状 + server.ts 接线（热区）+ 验证 + 提交；CC 只 review + 真机。
> 基线 `feature/camera-derive@<P0 合入后 HEAD，CC 通知>`。分支：`git worktree add -b feat/style-anchor-p1a ../wt-style-anchor <baseline>`。

## 一、范围拍板（越界即返工）

**做**：①项目级"风格锚图"资产（独立字段，**绝不复用人物母版**）：设置/清除/读取；②锚图版本号（内容变更即 +1，供 P2 定稿门"同锚图版本"判定）；③StyleBundle（P0 已建）追加 `styleAnchorUrl` / `styleAnchorVersion` 两字段并在两条管线的快照/审计中记录（**仅记录，不注入 prompt/conditioning**）；④前端：风格设定步骤加"上传/清除项目风格锚图"入口（独立于角色母版区）。
**不做**：Agnes referenceImages 传参、ComfyUI IPAdapter 节点、任何把锚图喂进生成的行为（全部 P1-B，等 A/B 结论）；定稿门（P2）；角色/PuLID 任何改动。

## 二、数据模型（零迁移，铁律 6）

项目 JSON（store `generated_scripts`）追加可选字段，旧数据零迁移、不建表：

```ts
styleAnchor?: {
  imageUrl: string;          // /uploads/... 本地相对路径
  version: number;           // 从 1 起；每次 setStyleAnchor 内容变化 +1
  updatedAt: string;
};
```

- 版本规则：`imageUrl` 与当前不同 → version+1；相同 → 不变（幂等）。清除 → 删字段（版本历史不保留，与"定稿指针干净删除"先例一致）。
- 锚图文件落 `uploads/style-anchors/<projectId>-<version>.<ext>`（上传即落盘，复用现有上传中间件/路径穿越防护语义）。

## 三、后端端点（新模块 `server/modules/style-anchor/`，照抄 camera-derive 结构；server.ts 1 import + 1 register）

1. `PUT /api/projects/:projectId/style-anchor`（multipart 或 `{ imageUrl }` 二选一，与现有母版上传方式对齐）→ 落盘+version 递增+mutateDb 写字段 → 返回 `{ styleAnchor }`。
2. `DELETE /api/projects/:projectId/style-anchor` → 删字段（文件可保留，非定稿物；如实现 unlink 需路径穿越防护）→ 返回 `{ cleared: true }`。
3. `GET` 并入现有项目读取即可（字段随项目 JSON 返回），不单开端点。
- deps：`mutateDb`、`readDb`、`uploadsDir`（照抄 scene-reference/export-deck 注册形状）。

## 四、StyleBundle 扩展与快照（server.ts 热区 + imageGen 模块）

- **server.ts 热区（仅 registerImageGenRouting 调用点，P0 已开的同一处）**：`resolveStyleContext` 回调返回值追加 `styleAnchorUrl: string | null`、`styleAnchorVersion: number | null`（从项目 `styleAnchor` 读，无则 null）。用既有 import 组装，不加新 import、不碰他处。
- **imageGen 模块**：`ImageStyleContext`/`StyleBundle`/摘要追加这两字段；Agnes 快照 summary（P0 的 `styleBundle` audit 块）与响应体带上它们；**`composeAgnesPrompt` 不变**（锚图不进 prompt）。shot JSON 追加可选 `gen_style_anchor_version`（成功写、缺席清，与 P0 的 `gen_style_contract_version` 同机制同位置）。
- ComfyUI 侧快照：**本包不改 server.ts 的 ComfyUI 生成路径**（禁碰）；ComfyUI 的锚图版本记录留 P1-B 与注入一起做（避免动 conditioning 前先动快照结构造成半成品）。

## 五、前端（`src/App.tsx` 或风格设定组件，仅锚图入口）

- 风格设定步骤（第①步）「项目风格 / Style Contract」区旁，加独立「风格锚图」卡片：上传/预览/清除；文案明确「仅用于统一色彩·材质·光影；不锁构图与人物；当前仅记录版本，注入能力验证后启用」（诚实标注未启用注入）。
- 不动角色母版区、不动 provider 选择器。

## 六、验证与验收

- 后端模块测试（mutateDb/readDb stub）：set 落盘+version 从 1 起、同图幂等不 +1、换图 +1、clear 删字段；路径穿越防护；GET 随项目返回。
- imageGen 测试扩展：resolveStyleContext 返回锚图字段 → StyleBundle 摘要/响应/shot JSON 带 `styleAnchorVersion`；锚图字段缺席 → 不写、不注入 prompt（composeAgnesPrompt 输出与 P0 逐字一致，回归断言）；forceProvider=comfyui_local 不受影响。
- **接线自验（Codex，沿用 P0）**：隔离起服（临时库/uploads/假 Agnes）证明真实 server.ts 下：设锚图 → 版本入项目 JSON → Agnes 请求快照与 shot JSON 带 `styleAnchorVersion`，且**图仍不含锚图 conditioning**（prompt 无锚图、无 referenceImages 传参）。
- `npm run lint` + `npm run build` + 全模块测试（当前 70/70 + 新增）+ imageGen 测试（19/19 + 新增）。
- 证据：`docs/ui-redesign/tasks/evidence/style-anchor-p1a-acceptance.md`。

## 七、边界（违反即返工）

- **允许改动**：新增 `server/modules/style-anchor/**`、`server/providers/imageGen/**`、server.ts **仅 register 新模块 1 行 + registerImageGenRouting 调用点热区**、`src/App.tsx`（或风格设定组件）仅锚图入口、证据文档。
- **禁碰**：server.ts 的 ComfyUI 生成/注入路径、Agnes 视频链路、其余 server/modules/**、角色母版/PuLID、config/**、index.css。
- **绝对红线**：本包**零**「锚图→生成」注入。任何把 styleAnchor 喂给 provider（referenceImages 传参、IPAdapter 节点、prompt 拼接）的代码即越界，整包返工——注入等 A/B 结论与 P1-B。
- 不加依赖；正式 db/uploads 零污染；真实 provider 计费零发生。提交前缀 `feat(style-anchor): ...`，不 push，完成通知 CC。

## 八、CC 并行/后续（非 Codex 范围）

- **P1 前置 A/B 调研（CC 真机，与本包并行，决定 P1-B 是否/如何注入）**：
  ①Agnes referenceImages 小样本 A/B——同 prompt 有/无锚图，人工判锚图是否只迁移风格、是否复制主体/构图/内容；记录 Agnes 有 referenceImages 时自动切换模型的行为差异。
  ②ComfyUI 侧 IPAdapter/style-reference 节点映射能力——现有工作流预设能否挂 IPAdapter 风格分支、与 PuLID 身份分支能否共存。
- P1-A 真机：设/换/清锚图版本正确、快照记录准确、图确实未被锚图影响（对照组）。
- A/B 通过 → 出 P1-B 注入任务书（双端消费本包已备好的锚图资产+版本）；不通过 → 锚图路线改道（如仅 ComfyUI 侧注入、Agnes 维持纯 prompt），资产层仍可复用。
