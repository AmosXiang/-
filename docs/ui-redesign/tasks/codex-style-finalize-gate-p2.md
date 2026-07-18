# 任务书（Codex）：风格定稿门 P2 · 查配方/版本/人工，非 provider

> 全文直接粘贴给 Codex。上下文自包含。
> **排在 P1-A（`codex-style-anchor-p1a.md`）之后做**：本包消费 P1-A 交付的 `gen_recipe` 配方指纹与 `gen_style_anchor_version`。**P1-A 未合入前不要开工**——基线以 CC 合入 P1-A 后通知的 HEAD 为准（下方占位）。
> **背景（四证据线定案，见 `evidence/agnes-referenceimages-ab-finding.md` / `evidence/comfyui-ipadapter-capability-finding.md`）**：图像级风格锚点架构性不可得；风格统一靠「P0 文本 overlay + 人工复核 + 漂移镜按批准配方重生」。P2＝把这套策略变成**可见、可追、要人工确认**的定稿门。用户原话拍板的判据：定稿应检查①同一风格契约版本②同一锚图版本③可接受的生成配方（provider+模型+工作流+关键强度）④本地图片存在/能解码/尺寸正确⑤人工视觉确认通过⑥相似度只作离群警告，**不自动淘汰**。
> **核心原则**：**同一 provider ≠ 同一风格**；定稿判据是"配方一致 + 版本当前 + 人工过"，绝不用 `gen_provider` 相同与否当依据。
> 分工（Codex 主导）：coding + deps/接线 + 验证 + 提交 + 隔离自验；CC 逐行 review + 真机。
> 基线 `feature/camera-derive@468d55f`（P1-A 已合入，`gen_recipe` / `buildRecipeFingerprint` / `applyShotRecipeRecords` 已就绪，从 `server/providers/imageGen/` 导出）。分支：`git worktree add -b feat/style-finalize-gate ../wt-finalize-gate 468d55f`。

## 一、范围拍板（越界即返工）

**做**：
1. 项目级"批准配方基线"（approved recipe）：用户可把某镜的 `gen_recipe` 指纹**钉为项目交付标准**；存项目 JSON 可选字段（零迁移）。
2. 定稿门检测（**扩展既有 export-deck `delivery-check`**，不新建端点）：逐镜产出确定性判据——契约版本当前、锚图版本当前、配方指纹匹配批准基线、图片本地存在且可解码、人工"风格已确认"标记。**只检测/报告，产出结构化 drift 明细**。
3. 人工"风格已确认"标记：每镜可置/撤 `styleApproved`（含确认时刻的指纹快照，配方一变即自动失效）。
4. 前端 DeliveryPanel + 检查器：展示 drift 分类与逐镜标记；"钉为批准配方""标记风格已确认""跳到漂移镜"操作。
5. 相似度**仅**低成本色彩直方图离群警告（无模型依赖），标注"仅提示、不淘汰"。

**不做（红线）**：
- **任何自动淘汰/自动重生/硬阻断导出**——门是"亮灯 + 要人工点头"，不替用户做决定。final-mode 导出的既有"未定稿即 409"逻辑**不动**；风格 drift **不新增硬阻断**（只在 summary 里显著呈现）。
- CLIP/语义相似度（需模型，留未来）；图像级注入（已判死）；配方指纹的**计算**（P1-A 已建 `buildRecipeFingerprint`，本包只**读**，禁止重写哈希逻辑——两处哈希若不一致则漂移判定失效）。
- ComfyUI/Agnes 生成路径、角色/PuLID、schema/建表。

## 二、数据模型（零迁移）

项目 JSON 追加可选：
```ts
approvedRecipe?: {
  fingerprint: string;        // 复制自某镜 gen_recipe.fingerprint
  recipe: object;             // 该镜 gen_recipe 结构体快照（展示/审计用）
  setFromShotId: string;
  setAt: string;
};
```
Shot JSON 追加可选：
```ts
styleApproved?: {
  approvedFingerprint: string;   // 确认时刻该镜 gen_recipe.fingerprint
  approvedAt: string;
};
// 有效性判定：styleApproved.approvedFingerprint === 当前 gen_recipe.fingerprint。
// 不等（配方被重生改变）→ 视为"确认已失效"，门重新亮灯。
```

## 三、判据组装（delivery-check 扩展，逐镜）

对每个 shot 产出（**均为确定性，无模型**）：
| 判据 | 规则 |
|---|---|
| `contractCurrent` | `gen_style_contract_version === 当前有效契约 version` |
| `anchorCurrent` | 无项目锚图 → true；有 → `gen_style_anchor_version === styleAnchor.version` |
| `recipeMatches` | 有 `approvedRecipe` → `gen_recipe.fingerprint === approvedRecipe.fingerprint`；无批准基线 → null（未设标准，不判漂移，UI 提示"先钉批准配方"） |
| `imageDecodable` | 本地终图存在 + sharp 可解码 + 宽高 > 0（复用既有 getLocalPath/isReadableFile + sharp.metadata） |
| `styleApprovedValid` | `styleApproved` 存在且指纹仍等于当前 gen_recipe |
| `colorOutlier`（可选） | 与批准基线镜的色彩直方图距离超阈值 → true（**仅警告**，进单独字段，不进 drift 计数硬指标） |

`summary` 追加 `styleGate: { total, contractStale, anchorStale, recipeDrift, undecodable, unapproved, colorOutliers, needsAttention }`；`details[]` 逐镜带上述布尔 + 缺失原因串。**recipeMatches=null（未设批准配方）不计入 needsAttention**，改为顶层一枚"未设定批准配方"提示。

## 四、后端接线（server.ts 仅 register 既有模块，无热区）

- 批准配方/风格确认的写操作：优先并入 **style-anchor 模块**（P1-A 新建）或 export-deck 模块的既有 deps（mutateDb），**不新开 server.ts 热区**（P2 不碰 server.ts 逻辑，仅可能 1 行 register 若新增子路由——能复用既有模块 deps 则零改 server.ts）。
  - `PUT /api/projects/:projectId/approved-recipe` body `{ shotId }` → 复制该镜 gen_recipe 为批准基线。
  - `DELETE` 同 → 清批准基线。
  - `PUT /api/generated-scripts/:projectId/shots/:shotId/style-approved` body `{ approved: boolean }` → 置/撤 styleApproved（置时快照当前指纹）。
- delivery-check 判据组装是纯读，放 export-deck 模块内既有 `performDeliveryCheck` 扩展。

## 五、前端（DeliveryPanel + 检查器）

1. DeliveryPanel 交付检查区：新增"风格一致性"分组——顶部"批准配方：已设（来自 #N）/ 未设定[钉当前镜为批准配方]"；逐镜 drift 明细（契约旧/锚图旧/配方漂移/无法解码/未人工确认/色彩离群）＋"跳到镜头"。
2. 检查器：该镜展示 5 判据小标 + "标记风格已确认/撤销"按钮（配方变则标记自动置灰失效）＋"钉为项目批准配方"。
3. 文案诚实：门是"人工复核辅助"，明示"不自动淘汰、不阻断导出；漂移镜请人工判断后用批准配方重生"。

## 六、验证与验收（严）

- delivery-check 判据单测（stub 项目数据）：契约/锚图版本一致与落后各态；有/无 approvedRecipe（无→recipeMatches=null 且不进 needsAttention）；指纹匹配/漂移；图片可解码/损坏/缺失；styleApproved 有效/因指纹变化失效；色彩离群进独立字段不进硬计数。
- 写操作测试：钉/清批准配方；置/撤 style-approved（快照指纹正确）；路径/项目不存在 404。
- **跨包一致性硬验**：本包读的 `gen_recipe.fingerprint` 与 P1-A 的 `buildRecipeFingerprint` 必须同源——测试须构造"同配方经 P1-A 函数产出的指纹"与门判定一致（禁止本包另算哈希）。
- 隔离自验（沿用先例）：起真服，造两镜——A 配方=批准基线、B 改 loraStrength（指纹不同）→ delivery-check：A recipeMatches=true、B=false 进 recipeDrift；改契约版本 → contractStale 命中；撤图 → undecodable 命中。
- `npm run lint` + `build` + 全模块测试（P1-A 后基线数 + 新增，不回归）。
- **诚实边界**：门只给确定性判据 + 色彩离群提示，**不宣称"风格是否统一"**——最终由人工视觉确认（styleApproved）。CLIP 语义相似度明确列未来。
- 证据：`docs/ui-redesign/tasks/evidence/style-finalize-gate-p2-acceptance.md`。

## 七、边界（违反即返工）

- **允许改动**：`server/modules/export-deck/**`（delivery-check 扩展）、`server/modules/style-anchor/**`（批准配方/风格确认写操作）及其测试、`src/components/DeliveryPanel.tsx`、检查器相关组件（`src/App.tsx` 若检查器在其中则仅限该镜风格判据展示块）、证据文档。server.ts **最多 1 行 register**（能复用既有 deps 则零改）。
- **禁碰**：server.ts 生成/路由/runtime 逻辑、Agnes/ComfyUI 生成路径、`buildRecipeFingerprint`（P1-A 所有，只读不改）、video-lab、角色/PuLID、config/**、index.css、schema。
- **红线**：零自动淘汰/重生/硬阻断；零重算哈希；零图像注入。
- 不建表不改 schema 不加依赖；正式 db/uploads 零污染；真实 provider 计费零发生。提交前缀 `feat(style-gate): ...`，不 push，完成通知 CC。

## 八、CC 后续

真机：钉批准配方 → 制造契约改版/锚图改版/配方漂移三种镜 → delivery-check 三类 drift 命中、人工确认置/撤与失效正确、色彩离群仅提示不拦截；导出 final-mode 既有 409 不回归。未来：CLIP 语义相似度作离群补充（需模型，另议）。
