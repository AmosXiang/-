# P3 Wiring Acceptance Evidence

Date: 2026-07-15

Branch: `feat/p3-wiring`

Baseline: `88b4599`

Worktree: `C:\Users\Owner\Documents\GitHub\wt-p3-wiring`

## Scope

- The project style contract is the authoritative source for storyboard preset, style overlay, dimensions, and LoRA strength.
- Confirmed batch generation is blocked until a complete contract is locked.
- Generated projects use `StyleContractPanel`; draft projects keep the legacy draft-only style and default-preset flow.
- The shot Inspector is organized into five disclosure zones, with camera tools nested under structure controls.
- Legacy projects without an initialized contract retain request-level preference and art-direction behavior.

## Static verification

```text
npx tsx --test server/modules/style-contract/routes.test.ts
PASS (6 tests, 0 failures)

npm run lint
> tsc --noEmit
PASS (0 errors)

npm run build
> vite build --configLoader runner
PASS (2085 modules transformed)
```

Vite emitted only its existing large-chunk advisory; the build completed successfully.

## HTTP acceptance on a database copy

The server was started on port `3013` with:

```text
SQLITE_DB_PATH=C:\Users\Owner\Documents\GitHub\wt-p3-wiring\.tmp\p3-acceptance.sqlite
UPLOADS_DIR=C:\Users\Owner\Documents\GitHub\-\uploads
DISABLE_COMFY_WORKER=true
```

The copy was made from the formal database before startup. The temporary database and logs were removed after acceptance.

### Unlocked confirmed batch is write-free

Fixture: `1784151722555-e524c596`

```json
{
  "tasksBefore": 0,
  "status": 409,
  "code": "STYLE_CONTRACT_NOT_LOCKED",
  "tasksAfter": 0,
  "noWrite": true
}
```

The preflight response reported:

```json
{
  "ready": false,
  "locked": false,
  "missing": ["storyboardPresetId", "styleOverlay", "width", "height", "loraStrength"]
}
```

### Locked contract passes and protects legacy write paths

Contract fixture: `1784151665870-c3234e57`

```json
{
  "version": 1,
  "locked": true,
  "storyboardPresetId": "pure_klein",
  "styleOverlay": "cinematic teal rain, soft volumetric station light",
  "width": 832,
  "height": 576,
  "loraStrength": 0.65
}
```

- Batch preflight returned `ready: true`, `locked: true`, and no missing fields.
- A preferences write requesting `shotPresetId: "sdxl_legacy"` returned and stored `pure_klein`.
- A legacy project update requesting `artDirection.overlay: "malicious override"` retained the contract overlay while preserving the unrelated `notes` field.
- The confirmed batch returned HTTP 200 and created one task.

### Single-shot malicious adjustments are overridden

A temporary local health stub was used only for the `/system_stats` connectivity check. The single-shot request attempted:

```json
{
  "presetId": "sdxl_legacy",
  "width": 256,
  "height": 256,
  "loraStrength": 0.1
}
```

The HTTP 200 response and stored task instead contained:

```json
{
  "workflowPresetId": "01_klein_character_master",
  "width": 832,
  "height": 576,
  "loraStrength": 0.65,
  "overlayInjected": true
}
```

Submitting a prompt that already contained the contract overlay produced exactly one overlay occurrence.

### Generation snapshot

The copied SQLite task row stored:

```json
{
  "storyVersion": 0,
  "styleContractVersion": 1,
  "basedOnStoryVersion": 0,
  "contractLocked": true,
  "effective": {
    "storyboardPresetId": "pure_klein",
    "styleOverlay": "cinematic teal rain, soft volumetric station light",
    "width": 832,
    "height": 576,
    "loraStrength": 0.65
  }
}
```

### Legacy compatibility

An uninitialized fixture returned `initialized: false`. Its request-level `shotPresetId: "sdxl_legacy"` and `artDirection.overlay: "legacy request overlay"` were both accepted unchanged.

## Browser acceptance

The app was run against the copied database on Vite/Express ports `3014/3015` and inspected in the local in-app browser.

- Style step: one locked `StyleContractPanel` rendered; the duplicate generated-project preset panel and duplicate step-3 overlay textarea were absent.
- Inspector: five zones rendered in order. Zones 1, 2, and 4 were open; zones 3 and 5 were closed; nested camera tools were closed.
- Inspector width: `clientWidth=279`, `scrollWidth=279`; document horizontal overflow was false.
- Read-only style zone expanded without overflow and displayed preset, checkpoint, dimensions, LoRA strength, and overlay.
- Advanced modal: preset, model, negative prompt, width, and height were disabled; Prompt and both Seed modes remained enabled.
- Browser console errors: `0`.

## Boundary check

Tracked implementation changes are limited to:

- `server.ts`
- `src/App.tsx`
- `src/index.css`
- `src/components/StyleContractPanel.tsx` (optional refresh prop only)
- this evidence document

No router, entrypoint, module implementation, dependency, upload asset, or formal database file was changed.

## CC review follow-up

The approved review identified that the batch route pre-appended the overlay before `optimizePrompt`, so an optimizer rewrite could prevent the later exact-string idempotency check from recognizing the first injection.

The batch route now passes only `shot.description` into `prepareComfyTaskData`. The shared preparation path performs the sole overlay injection after prompt optimization. This removes the optimizer-dependent double-injection path and also removes the redundant batch-level contract resolution.

The suggested broad `&& !reqPresetRole` guard was not added. No current shot caller sends `presetRole`, and accepting any caller-supplied role as a contract bypass would weaken the current authority boundary. A future shot upscale operation should introduce an explicit non-storyboard operation/view discriminator and test that discriminator rather than treating every non-empty `presetRole` as trusted.
