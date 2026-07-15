# Style contract acceptance evidence

Date: 2026-07-15

Branch/base: `feat/style-contract` from `ef51af7`

Isolation: `.pnpm-store/worktrees/style-contract`
Result for WP-G scope: **PASS**

## Automated backend tests

Command:

```powershell
npx tsx --test server/modules/style-contract/routes.test.ts
```

Observed result:

```text
tests 6
pass 6
fail 0
duration_ms 591.9792
```

The complete modular backend suite was then run with every `server/modules/**/*.test.ts` file: **30 passed, 0 failed**.

Covered behavior:

- legacy `comfyuiPreferences.shotPresetId` and `artDirection.overlay` derive an unpersisted draft;
- first save creates v1 and write-through preserves unrelated legacy fields;
- changed content increments version, while a normalized no-op PUT keeps version and `updatedAt` unchanged;
- lock/unlock keep the version stable, locked PUT returns `409 CONTRACT_LOCKED`, and PUT with `lock:true` saves and locks atomically;
- uninitialized lock returns `422 CONTRACT_INCOMPLETE` with deterministic `missing` fields;
- preflight is ready only for a complete locked contract;
- invalid object/type/range inputs return stable machine-readable 400/422 responses;
- `resolveEffectiveStyleContract` returns stored values after initialization and legacy fallbacks without mutating old projects.

## HTTP acceptance on a database copy

The server was started with:

```text
SQLITE_DB_PATH=test-artifacts/style-contract/curl-acceptance.sqlite
PORT=3004
DISABLE_COMFY_WORKER=true
```

`curl-acceptance.sqlite` was copied from the workspace `db.sqlite` before startup. The formal database was never configured as the running server's write target.

Observed curl flow:

| Step | HTTP | Key response |
| --- | ---: | --- |
| GET uninitialized | 200 | `initialized:false`, `version:0`, legacy preset/overlay derived |
| PUT v1 | 200 | `version:1`, `locked:false` |
| identical PUT | 200 | remains `version:1` |
| changed PUT | 200 | `version:2`, width changed to `1280` |
| lock | 200 | `version:2`, `locked:true` |
| PUT while locked | 409 | `CONTRACT_LOCKED` |
| unlock | 200 | `version:2`, `locked:false` |
| lock uninitialized second project | 422 | `CONTRACT_INCOMPLETE` plus all five missing field names |
| preflight after unlock | 200 | `ready:false`, `locked:false`, `missing:[]` |

Write-through re-read from the copied database/API returned:

```json
{
  "shotPresetId": "sdxl_legacy",
  "overlay": "acceptance cinematic lighting"
}
```

## TypeScript, build, and component self-check

```text
npm run lint  -> PASS (tsc --noEmit)
npm run build -> PASS (2083 modules transformed)
```

The existing Vite chunk-size warning remains informational and was not introduced by the unmounted components.

Component source checks completed:

- native labels/fieldset controls and visible keyboard focus styles are present;
- error/status content uses `role="alert"` / `role="status"`;
- invalid server fields map to `aria-invalid` and visible red borders;
- action controls use a minimum 40px height and remain text-labelled rather than color-only;
- responsive grids collapse to one column and avoid fixed-width page containers;
- dirty state cannot call the standalone lock action; `Save and lock` uses the atomic PUT contract;
- preset choices come from `/api/comfyui/presets?purpose=storyboard`, with unavailable options disabled.

Full rendered browser QA is intentionally deferred until CC mounts the two components in `App.tsx`; that integration file is outside WP-G's authorized boundary.

## Boundary audit

Changed files are limited to:

- `server/modules/style-contract/*`;
- `src/components/StyleContractPanel.tsx`;
- `src/components/StyleContractReadonly.tsx`;
- `src/types.ts`;
- one import and one registration line in `server.ts`;
- this acceptance evidence file.

No dependency, table, production database, existing module, or frontend hotspot file was modified.
