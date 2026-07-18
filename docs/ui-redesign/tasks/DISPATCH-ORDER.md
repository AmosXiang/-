# Codex 派发顺序（风格线收尾队列）

> CC 维护。当前待派任务书按此顺序做，**一包合入后再开下一包**（后包基线依赖前包合入的 HEAD）。其余 `codex-*.md` / `antigravity-*.md` 均已有 evidence＝已合入，勿重跑。

## 队列

| 顺序 | 任务书 | 基线 | 依赖 | 状态 |
|---|---|---|---|---|
| 1 | `codex-style-anchor-p1a.md`（v2：风格锚图复核基准 + **配方指纹**地基） | `feature/camera-derive@f1740f5` | 无（P0 已合入） | **✅ 已合入（4df63f7；CC review+真机 PASS，evidence 有 CC 增补节）** |
| 2 | `codex-style-finalize-gate-p2.md`（风格定稿门：查配方/版本/人工，非 provider） | **`feature/camera-derive@468d55f`** | P1-A 已合入，`gen_recipe`/`buildRecipeFingerprint` 就绪 | **🟢 可开工** |

## 硬约束（两包共用）

- 每包独立 worktree（`git worktree add`），CC 逐行 review + 真机后才合入，再开下一包。
- **配方指纹哈希 `buildRecipeFingerprint` 由 P1-A 建、P2 只读**——两处哈希不一致则漂移判定失效，P2 严禁重算。
- **零图像级注入（永久）**：图像级风格锚点已被四证据线判死（`evidence/agnes-referenceimages-ab-finding.md`、`evidence/comfyui-ipadapter-capability-finding.md`）；两包均纯记录/展示，任何把图喂给 provider 即返工。
- **P2 零自动淘汰/硬阻断**：定稿门只亮灯 + 要人工点头。

## 队列之后（无任务书，CC/用户另议）

- CLIP 语义相似度作离群补充（需模型）。
- 图像级锚点：仅当整族切换或 BFL 出 Flux.2 原生风格适配器时重启，属大决策。
