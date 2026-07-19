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
