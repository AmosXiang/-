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
