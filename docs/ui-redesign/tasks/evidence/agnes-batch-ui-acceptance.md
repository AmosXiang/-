# Agnes Batch UI Acceptance Evidence

Date: 2026-07-17

Branch: `feat/agnes-batch-ui`

Baseline: `4b0fc26511bfcd7f03b4f1c8b6a25c12e4222359`

Worktree: `C:\Users\Owner\Documents\GitHub\wt-agnes-batch`

## Delivered scope

- Kept the existing online ComfyUI `handleBatchGenerate` implementation unchanged: preflight `POST /api/comfyui/shots/generate-all`, existing confirmation, then the same endpoint with `confirmed: true`.
- Added a separate offline Agnes path that is reachable only while ComfyUI is disconnected and `regenerateMode === 'missing'`.
- Reused the existing generate-all preflight without `confirmed`; no ComfyUI task is created by this request.
- Split `preflight.items` into Agnes targets (`matchedCharacters.length === 0`) and skipped local-only shots (all remaining items, including character and missing-Avatar cases).
- Submitted Agnes targets one at a time with `await`, continued after per-shot failure, and reused `applyAgnesShotImage` after every successful synchronous response.
- Added a ref-backed stop request. The current request is allowed to finish, then the loop stops before starting another shot. A run id invalidates the loop on project switch or component cleanup.
- Reused `generatingShotIndex` for the active card and `shotCharacterFeedback` for progress, final summary, and per-shot failure details.
- Updated both batch entries so offline `missing` is enabled, offline `failed`/`all` is disabled with the required tooltip, and an active Agnes batch becomes `停止 Agnes 批量`.
- Added no frontend rate limiter, dependency, component, server route, or server/config change.

## Shared request-body contract

The single-shot ComfyUI branch and offline batch loop both call the same `buildShotImageRequestBody(script, shot, shotIndex)` helper. There is no second batch-specific body definition.

The shared helper owns these fields:

```text
presetId
prompt
negativePrompt
isCharacter
style
platform
model
projectId
targetType
targetId
viewType
shotIndex
```

`forceProvider` is absent. In the browser stub evidence, all four offline requests had the same serialized field set (with `model` naturally omitted because its shared value was `undefined`) and `forceProviderCount=0`.

## Automated verification

The isolated worktree reused the main checkout's existing dependencies through a temporary `node_modules` junction. The junction and build output were removed after verification.

```text
npm run lint
PASS: tsc --noEmit, 0 errors

npm run build
PASS: 2091 modules transformed, production bundle emitted
NOTE: Vite emitted only the existing large-chunk advisory.
```

All module tests were discovered recursively:

```powershell
$tests = Get-ChildItem 'server\modules' -Recurse -Filter '*.test.ts' |
  Sort-Object FullName |
  ForEach-Object { $_.FullName }
.\node_modules\.bin\tsx.cmd --test $tests
```

```text
PASS: 60 tests, 0 failures
```

Image-provider tests:

```text
node --experimental-transform-types --test server/providers/imageGen/*.test.ts
PASS: 10 tests, 0 failures
```

The image-provider suite used fixture providers only. No real image generation was requested.

## Browser and stub acceptance

The production build was exercised in the in-app browser through a temporary localhost stub on port 4190. The UI loaded the existing local project `1783192733645`, while the stub intercepted runtime, batch preflight/confirmation, task polling, and image-generation calls. The synthetic preflight contained six items:

- Agnes targets: `shotIndex` 26, 36, 37, 40;
- local-only/skipped targets: `shotIndex` 27, 38.

Successful stub images were data URLs. No provider key was present or transmitted, no real Agnes request was made, and the confirmed online request was intercepted instead of creating tasks.

| Scenario | Browser/request evidence | Result |
| --- | --- | --- |
| ComfyUI online + `missing` | Header changed to `ComfyUI · 外部运行`; primary button remained enabled with the original online title. Events contained exactly two generate-all calls: `{projectId, regenerateMode:'missing'}` then the same body plus `confirmed:true`. Image request count was `0`. | PASS (stub) |
| Offline + `missing`, mixed empty/character shots | Primary button was enabled with title `离线经 Agnes 串行生成无人物的缺失分镜`. A native confirmation appeared; the exact source literal separately reports Agnes `4`, skipped `2`, and `4 × 45` seconds with serial/browser-open guidance. After acceptance, only indexes `26,36,37,40` were submitted. `maxActiveImages=1`; final UI status was `Agnes 批量已结束：完成 4 / 失败 0 / 跳过 2（需本地 ComfyUI）`. | PASS (stub) |
| Offline per-shot 500/409 | Response order was `26:200, 36:500, 37:409, 40:200`, proving both failures did not block later shots. Final UI status was `完成 2 / 失败 2 / 跳过 2` and included `shotIndex 36 ... HTTP 500：stub 500` plus `shotIndex 37 ... HTTP 409：stub 409`. `maxActiveImages=1`. | PASS (stub) |
| Offline stop during active shot | The stub used a deterministic 10-second current-shot delay. While that request was active, the button changed to `停止 Agnes 批量`; clicking it produced exactly one image start/end (`shotIndex 26`) and no second request. Final UI status was `Agnes 批量已中止：完成 1 / 失败 0 / 跳过 2（需本地 ComfyUI）`. | PASS (stub) |
| Offline `failed` / `all` | The primary entry was disabled in both modes with title `该模式需本地 ComfyUI；缺失镜可离线经 Agnes 批量生成`. The secondary `一键生成缺失分镜` entry was also disabled with the same title while mode was `all`. Restoring `missing` enabled the secondary entry and clicking it opened the Agnes confirmation. | PASS (stub) |
| Style contract unlocked + offline `missing` | One preflight call returned `styleContract.ready=false`. The existing alert appeared, image request count stayed `0`, and the UI returned to step 1 `风格设定`. | PASS (stub) |

The browser-control surface exposes native dialog type but not dialog message text, so the confirmation's appearance was browser-verified and its exact three-number copy was source-verified at the same handler literal. All other status strings above were read from rendered DOM state.

## Data, process, and boundary audit

- Acceptance sent no real Agnes request and caused no provider billing.
- The temporary stub forwarded ordinary API reads to the already-running local backend but intercepted all generate-all and generate-image writes used by the matrix.
- The browser tab was finalized; the temporary port 4190 listener was stopped.
- The temporary stub script/logs, production `dist/`, and temporary `node_modules` junction were removed.
- No `db.sqlite`, `uploads/`, generated image, or acceptance screenshot was added to the worktree.
- Final package scope is limited to `src/App.tsx` and this evidence document.
- `server.ts`, `server/**`, `config/**`, `components/**`, `index.css`, `router.ts`, `main.tsx`, dependency manifests, and lockfiles are unchanged.

## CC review handoff

CC should focus real-machine regression on:

- offline + real Agnes with 2-3 empty missing shots, including visible serial progress and server-side limiter waiting;
- a stop click while one real request is in flight;
- one real failure/409 path followed by a successful later shot;
- online ComfyUI `missing` regression, confirming every selected shot still follows the existing local generate-all queue;
- browser/project switching during a long request, confirming no subsequent shot starts and the old project does not overwrite the newly selected UI.

Real Agnes and a live ComfyUI run remain intentionally outside this zero-billing Codex package.
