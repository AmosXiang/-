# Style Anchor P1-A v2 Acceptance Evidence

- Baseline: `feature/camera-derive@f1740f5`
- Worktree branch: `feat/style-anchor-p1a`
- Date: 2026-07-18
- Scope: versioned manual-review style anchor plus stable generation recipe provenance. This package does not implement P2 gating and does not claim that generated images are stylistically uniform.

## Delivered facts

- Project JSON stores optional `styleAnchor` with a local `/uploads/style-anchors/<projectId>-<version>.<ext>` URL, version, optional note, and update time.
- Identical image bytes are idempotent; changed bytes increment the anchor version; clearing deletes the JSON field and the exact guarded local asset.
- `buildRecipeFingerprint` is the single implementation used by Agnes and ComfyUI. It canonicalizes key order and numeric precision, distinguishes explicit null from missing optional facts, and hashes SHA-1 to 16 hexadecimal characters.
- Prompt, seed, request id, and timestamps are explicitly excluded from the fingerprint. Provider, model, workflow preset, contract version, anchor version, and available visual parameters are included.
- Agnes and ComfyUI write `gen_recipe` and `gen_style_anchor_version` to shot JSON. The inspector only displays recipe/version status; it does not block generation, finalization, or export.

## Automated verification

### Focused P1-A tests

Command:

```powershell
node_modules\.bin\tsx.cmd --test server/providers/imageGen/recipeFingerprint.test.ts server/modules/style-anchor/routes.test.ts server/providers/imageGen/styleBundle.test.ts server/providers/imageGen/routes.test.ts
```

Result: **25 passed, 0 failed**.

Coverage includes:

- anchor set/idempotent replace/version increment/note-only update/clear/path traversal;
- stable hash across two independent Node processes;
- key-order independence, fixed numeric precision, ignored prompt/seed/time/request id, null versus missing;
- every visual recipe fact changes the fingerprint;
- ComfyUI shot stamping leaves workflow snapshots byte-identical;
- Agnes response/audit/shot provenance and missing-anchor behavior;
- explicit `referenceImages` in the incoming HTTP body is not forwarded to the Agnes provider request.

### Full server module and image-provider regression

Command:

```powershell
$tests = @((rg --files server/modules -g '*.test.ts')) + @((rg --files server/providers/imageGen -g '*.test.ts'))
node_modules\.bin\tsx.cmd --test $tests
```

Result: **99 passed, 0 failed**.

### Static and production build gates

- `npm run lint` — **PASS** (`tsc --noEmit`)
- `node_modules\.bin\tsc.cmd --noEmit` — **PASS**
- `npm run build` — **PASS**, 2,092 modules transformed. Vite reported only the existing large-chunk advisory.

## Isolated live wiring self-test

The successful run used:

- temporary SQLite database and temporary uploads directory under the Windows temp root;
- Express on `127.0.0.1:3137`;
- fake Agnes HTTP API/image server on `127.0.0.1:3138`;
- `DISABLE_COMFY_WORKER=true`, `COMFYUI_AUTOSTART=false`;
- no real provider key, billing, formal database, or formal uploads.

Observed result:

```json
{
  "anchorVersion": 1,
  "anchorUrl": "/uploads/style-anchors/p1-1.jpg",
  "agnesStableFingerprint": "d5cfc35a84627428",
  "agnesChangedFingerprint": "0cfe232edabeaa18",
  "agnesReferenceFieldsAbsent": true,
  "agnesPromptAnchorFree": true,
  "agnesLocalImageExists": true,
  "shotAgnesRecipePersisted": true,
  "comfyRecipePersisted": true,
  "comfyProvider": "comfyui_local",
  "formalWorkspaceDbUntouched": true
}
```

The run uploaded a real anchor image, generated two fake-Agnes images with different prompt/seed but the same recipe fingerprint, changed LoRA strength and observed a different fingerprint, verified Agnes shot provenance, then queued a ComfyUI shot and verified its response fingerprint exactly matched shot JSON.

The isolated services were stopped, their validated dedicated temp directory was removed, and ports 3137/3138 had no listening process afterward.

## Zero image-level injection proof

**PASS.** This was checked twice:

1. Regression tests pass an incoming `referenceImages` array and assert that the Agnes provider request contains no `referenceImages` property and that the composed prompt contains no style-anchor path.
2. The live fake Agnes server inspected the actual HTTP request. It contained neither `tags` nor `extra_body`, and its prompt contained neither `style-anchors` nor the anchor note (`manual review only`).

The style anchor URL/version are read only for review/provenance. They are never appended to prompt text, `referenceImages`, IPAdapter, Redux, ReferenceLatent, or any conditioning/workflow node.

## Honest boundary

This package proves asset versioning, recipe traceability, stable drift facts, read-only UI visibility, and zero image-level injection. It does **not** prove visual style consistency. Final visual judgment remains manual; any future blocking/finalization rule belongs to P2.

---

## CC 复核与真机（2026-07-18，合入 4df63f7）

**逐行 review PASS**：
- 范围：改动落在允许集（StyleAnchorPanel/StyleContractReadonly＝§五 风格设定/检查器组件）；server.ts 改动全部服务于「ComfyUI 任务落库写指纹」——单镜（generate-image handler）+ 批量（generate-all）两条 INSERT 路径 + registerImageGenRouting 热区补 styleAnchor* + 新模块 1 行 register；`stampComfyTaskRecipes`/`buildComfyTaskRecipe` 新 helper。L8002 的 @@ 头 "registerExportDeckModule" 仅为 diff 上下文标签，实际加的是 `registerStyleAnchorModule` 一行，未碰 export-deck。
- **红线①零图像注入（物理达成）**：`composeAgnesPrompt` 未改；`referenceImages` 从 types→routes→provider **端到端删除**（provider 删 `referenceDataUrl`、model 硬钉 2.1-flash、`reference_count:0`）。真机对照：设锚图 v2 后生成空镜，产图为干净月光庭院、**无锚图（手+鼠标）任何痕迹**，`reference_count=0`、`model=agnes-image-2.1-flash`；锚图仅作 `gen_style_anchor_version=2` 元数据记录。**注**：此项删除超出任务书字面范围（任务书只要求"不用锚图注入"），CC 判为与永久红线同向的加固、予以保留，已报用户知情。
- **红线②哈希跨进程稳定**：`recipeFingerprint.ts` params 键 `.sort()`、浮点 `toFixed(2)`/整数 `Math.round`、`-0→0`、canonical 用数组套数组（序列化顺序跨运行时确定）、undefined/null 用 tag 区分、params 值带 `typeof`；实证：键序打乱+精度(0.4235≈0.42)+prompt/seed/timestamp 噪声→同指纹 `3ae89567cf8505aa`，改 loraStrength→变。
- 跨 provider 共用同一 `buildRecipeFingerprint`（Agnes 与 ComfyUI 均经此）。
- style-anchor 模块：sha256 内容摘要判幂等（同图不 +1）、换图 +1、路径穿越三重防护、sharp 解码校验、旧文件清理。

**真机（真实 Agnes）**：
- 锚图版本：设 img1→v1、同图再设→v1（幂等）、换 img2→v2。
- 空镜生成：shot JSON 落 `gen_recipe`（fp=11aebb0c…）+ `gen_style_anchor_version=2`；响应带 recipe/版本；产图零锚图影响（见上）。
- DELETE 清锚图返回 `styleAnchor:null`。
- 清理：借用镜头 #3 快照复原、测试锚图 DELETE 清除，项目回到测试前无锚图状态。

`npm run lint` PASS；模块+imageGen 测试 **99/99**（含新增 recipeFingerprint/style-anchor 用例）。合入 `feature/camera-derive@4df63f7`。

**遗留提示**：referenceImages 能力已从 Agnes 图路径移除——`POST /api/generate-image` 传 referenceImages 现被静默忽略（字段已从 ImageGenRequest 删）。与图像级注入判死一致，但改变了既有请求契约，记录备查。
