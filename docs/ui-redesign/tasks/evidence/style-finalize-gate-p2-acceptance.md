# Style Finalize Gate P2 Acceptance Evidence

- Baseline: `feature/camera-derive@468d55f`
- Worktree branch: `feat/style-finalize-gate`
- Date: 2026-07-18
- Scope: deterministic recipe/version/image checks plus explicit human approval. This package does not inject images, regenerate shots, automatically reject shots, or add a style-based export block.

## Delivered facts

- A project can pin one shot's existing `gen_recipe` as `approvedRecipe`; the stored value is an exact recipe snapshot with source shot and timestamp. P2 never recomputes a production fingerprint.
- A shot can set or revoke `styleApproved`. Approval stores the current fingerprint; a later recipe change makes the approval invalid by comparison without silently deleting its audit snapshot.
- `delivery-check` now returns `styleGate.details` for every shot: contract version current, anchor version current, recipe match (`null` when no approved baseline), local image decodable, human approval valid, and color outlier warning.
- `styleGate.needsAttention` counts hard deterministic criteria only. Missing approved recipe does not create recipe drift; color outliers are reported separately and never enter the hard count.
- Image validation uses Sharp metadata with positive dimensions. Color comparison uses a normalized 4×4×4 RGB histogram on a 32×32 decode and a total-variation threshold of `0.55`.
- DeliveryPanel and the shot inspector expose pin/clear recipe, approve/revoke style, five criteria badges, drift navigation, and honest warning-only copy.

## Automated verification

### Focused P2 and export regression

```powershell
node_modules\.bin\tsx.cmd --test server/modules/style-anchor/routes.test.ts server/modules/export-deck/styleGate.test.ts server/modules/export-deck/routes.test.ts server/modules/export-deck/ffprobe.test.ts
```

Result: **27 passed, 0 failed**.

Coverage includes:

- pin/clear approved recipe and approve/revoke shot style;
- project/shot/recipe/input error buckets;
- direct consumption of fingerprints produced by P1-A `buildRecipeFingerprint`;
- current/stale contract and anchor versions;
- recipe match/drift and approval invalidation after a fingerprint change;
- missing approved recipe returning `recipeMatches=null` without recipe drift;
- valid, corrupt, and missing local images;
- color outlier warnings excluded from hard attention counts;
- existing delivery-check, final-mode 409, export deck, final-video, and failure-diagnostic behavior.

### Full server module and image-provider regression

```powershell
$tests = @((rg --files server/modules -g '*.test.ts')) + @((rg --files server/providers/imageGen -g '*.test.ts'))
node_modules\.bin\tsx.cmd --test $tests
```

Result: **104 passed, 0 failed**.

### Static and production build gates

- `npm run lint` — **PASS** (`tsc --noEmit`)
- `npm run build` — **PASS**, 2,092 modules transformed. Vite reported only the existing large-chunk advisory.

## Isolated live-server wiring self-test

Command:

```powershell
node_modules\.bin\tsx.cmd server/modules/export-deck/styleGate.acceptance.ts
```

The script created a dedicated temporary SQLite database and uploads directory, launched the real Express server on an ephemeral loopback port with the ComfyUI worker/autostart disabled, and made no provider request.

Observed result:

```json
{
  "approvedFingerprint": "92c589a6b74af670",
  "driftFingerprint": "322f109ad5a5acba",
  "recipeMatches": {
    "shotA": true,
    "shotB": false
  },
  "recipeDrift": 1,
  "styleApprovalsPersisted": true,
  "contractStaleAfterVersionChange": 2,
  "undecodableAfterImageRemoval": 1,
  "colorOutlierWarningOnly": 1,
  "realProviderCalls": 0,
  "formalWorkspaceDbUntouched": true,
  "formalWorkspaceUploadsUntouched": true
}
```

The isolated server persisted the approved recipe and both shot approvals. Shot A matched the approved recipe; Shot B changed only LoRA strength and drifted. Raising the contract version marked both shots stale, and deleting Shot B's local image marked it undecodable. The child server and dedicated temp directory were removed in `finally`.

## Boundary audit

- `server.ts`: **zero diff**; the existing style-anchor registration is reused.
- `server/providers/imageGen/**` and `buildRecipeFingerprint`: **zero production diff**. Tests and the acceptance script call the P1-A function only to construct authoritative fixtures.
- Agnes/ComfyUI generation, workflow, provider routing, character/PuLID, schema, config, and `index.css`: **zero diff**.
- Final export blocking remains the existing `summary.notFinalized > 0` check. Style drift is present only in the response/UI and never enters that condition.
- No image reference is sent to any provider, prompt, conditioning node, IPAdapter, Redux, or ReferenceLatent path.

## Honest boundary

P2 reports deterministic provenance, file-decode state, and a low-cost color warning. It does **not** determine whether images are visually consistent. Human `styleApproved` remains the final judgment; CLIP or semantic similarity remains future work. Browser/real-machine interaction is reserved for CC review after this local package.

---

## CC 复核与真机（2026-07-19，合入 f706610）

**逐行 review PASS**（四红线全守）：
- **server.ts 零改动**兑现（不在 diff）；父提交严格 `468d55f`。范围合规（export-deck/** + style-anchor/** + DeliveryPanel + StyleContractReadonly[检查器组件] + App.tsx 1 行 + 证据）。
- **红线①零指纹重算**：`styleGate.ts` 只 `fingerprintOf(shot.gen_recipe)` 取字符串，`recipeMatches = fingerprint === approvedFingerprint` 纯比较；无 buildRecipeFingerprint/createHash（grep 证实）。
- **红线②零图像注入**：门只读（sharp 解码判 decodable + 色彩直方图），无 provider 调用。
- **红线③零自动淘汰/新增阻断**：styleGate 仅加进 delivery-check summary（因 sharp 解码改 async）；final-mode 409（notFinalized>0）逻辑**逐字未动**，风格 drift 不新增任何 4xx。
- **色彩离群仅警告**：`colorOutlier → warnings[]`，`detailNeedsAttention = reasons.length>0` 不含它；`recipeMatches===null`（无基线）不触发 recipe_drift。
- 批准/确认写操作快照当前 `gen_recipe.fingerprint`；无有效 recipe 时拒绝钉/确认。

**真机（真实 server + 真实端点，DB 副本手术隔离）**：
- baseline delivery-check：styleGate 存在、`approvedRecipeMissing=true`、无基线 `recipeDrift=0`、needsAttention=74（全镜未人工确认，符合"人工确认是判据"语义）。
- 钉批准配方 → `approvedRecipe.fingerprint` 落项目；delivery-check：该镜 `recipeMatches=true`、其余 73 镜 `recipeDrift=73`（不匹配基线，正确）。
- 标记 style-approved → `styleApproved.approvedFingerprint` 快照当前指纹；该镜 `styleApprovedValid=true`、`needsAttention=false reasons=[]` 完全过门。
- **漂移 + 自动失效**：改该镜 gen_recipe.fingerprint → `recipeMatches=false`（recipeDrift 计数+1）**且** `styleApprovedValid` 自动失效（批准时快照指纹已不等于当前）→ `reasons=["recipe_drift","style_unapproved"]`。这是 P2 核心价值：配方一变，过期"已确认"自动作废。
- 清理：借用镜头快照复原、approvedRecipe/styleApproved 清除，项目回测试前干净态（approvedRecipe=null、styleApproved=0、gen_recipe=0）。

**诚实边界**：本轮 Agnes 图片上游持续 503（Service busy，外部过载，非代码），故门测试的 gen_recipe 采用**直接种入**而非现场 Agnes 生成——P2 契约是"读取+比对指纹"（已证零重算），配方**生产**在 P1-A 已用真实 Agnes 验过（见 style-anchor-p1a §CC 增补）；门的读取/比对/漂移/失效全经真实 server 端点验证。

`npm run lint` PASS；模块+imageGen 测试 **104/104**。合入 `feature/camera-derive@f706610`。**风格线 P0→P1-A→P2 收口**（图像级锚点架构性判死，四证据线在案）。
