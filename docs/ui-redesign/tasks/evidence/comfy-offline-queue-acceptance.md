# ComfyUI Offline Queue Acceptance Evidence

Date: 2026-07-17

Baseline: `86b36d8803485a70c8ed9b70983aba4bcbba99ce`

Worktree: `C:\Users\Owner\.codex\worktrees\d8fe\-` (Codex-managed detached worktree)

## Delivered scope

- `/api/generate-image` no longer returns `503 COMFYUI_UNAVAILABLE` merely because the local ComfyUI probe fails. The handler records `comfyOnline`, creates the task, initializes offline tasks as `pending / waiting_for_comfyui`, and returns `{ taskId, comfyOnline }`.
- `submitComfyTask` explicitly handles `preflight.online === false` before `assertComfyPreflight`: the task returns to `pending / waiting_for_comfyui`, `error` and `submittedAt` are cleared, and the original catch remains the failure path for every non-offline error.
- The worker remembers the last offline probe and skips submission attempts for 30 seconds. A successful handler or worker probe clears the backoff immediately.
- Entering and leaving the wait state use structured `[Worker] waiting_for_comfyui` and `[Worker] resumed` logs. Repeated offline probes do not repeat the wait-entry log for an already-waiting task.
- `ImageGenRouter` checks `configPath` mtime on requests, rereads only when mtime changes, and retains the last valid config after a parse/validation failure while emitting `config_reload_failed`.
- The single-shot local-provider button remains clickable while ComfyUI is offline. Its amber copy now explains that the task will wait in the queue.

## Automated verification

```text
npm.cmd run lint
PASS: tsc --noEmit, 0 errors

npm.cmd run build
PASS: 2091 modules transformed and production bundle emitted
NOTE: existing large-chunk advisory only
```

All tests discovered under `server/modules/**` were run together:

```powershell
$tests = Get-ChildItem 'server\modules' -Recurse -Filter '*.test.ts' |
  Sort-Object FullName |
  ForEach-Object { $_.FullName }
.\node_modules\.bin\tsx.cmd --test $tests
```

```text
PASS: 70 tests, 0 failures
```

The taskbook cited an earlier `60/60` total; this exact baseline currently discovers 70 module tests, so the evidence records the observed count rather than forcing the stale expected count.

Image-provider tests:

```text
node --experimental-transform-types --test server/providers/imageGen/*.test.ts
PASS: 11 tests, 0 failures
```

The added route test proves all three states in one process: `autoRoute=false` passes through, an mtime-changing rewrite to `autoRoute=true` routes the next request to the Agnes stub, and invalid JSON logs `config_reload_failed` while the prior valid route remains active.

## Isolated backend acceptance

The offline server used only:

```text
PORT=4197
SQLITE_DB_PATH=%TEMP%\comfy-offline-queue-codex-d8fe\db.sqlite
UPLOADS_DIR=%TEMP%\comfy-offline-queue-codex-d8fe\uploads
COMFYUI_API_URL=http://127.0.0.1:65530
COMFYUI_ROOT=%TEMP%\comfy-offline-queue-codex-d8fe\absent-comfyui
COMFYUI_AUTOSTART=false
COMFYUI_MANAGED_LAUNCH_ENABLED=false
COMFYUI_CKPT_NAME=offline-acceptance.safetensors
AGNES_API_KEY=
```

Port `65530` had no listener and no real ComfyUI or provider call was made. The temporary checkpoint name only lets the existing SDXL task builder snapshot a model while offline; it does not load a model or invoke a provider. Without either a request model, a preset snapshot, or `COMFYUI_CKPT_NAME`, this baseline's legacy SDXL builder still queries ComfyUI for a checkpoint outside the two approved `server.ts` hot zones, so the isolated run states this prerequisite explicitly.

| Scenario | Evidence | Result |
| --- | --- | --- |
| Offline + `forceProvider=comfyui_local` | HTTP 200, task `83ee12e5-4dd0-41d8-b358-724f8bae998f`, `comfyOnline:false`; persisted `pending / waiting_for_comfyui`, `error:null`, `submittedAt:null` | PASS |
| Offline + automatic routing with a character shot | HTTP 200, route reason `has_character_local`, task `29e18e74-7aa7-430a-a03c-630379d96e3a`, same persisted wait state | PASS |
| Offline + automatic routing with an empty shot | The same-process route test switched the temporary config to `autoRoute=true`; the next empty-shot request returned the Agnes fixture result and never reached the legacy handler | PASS (stub, no provider call) |
| Duplicate local slot | Reposting the forced request returned HTTP 409 with `existingTaskId=83ee12e5-4dd0-41d8-b358-724f8bae998f` | PASS |
| Worker offline for more than 90 seconds | At `2026-07-17T09:47:49-07:00`, both tasks still had `pending / waiting_for_comfyui`, null error, null submitted/completed timestamps | PASS |
| Non-offline preflight failure | A localhost response stub made `/system_stats` and `/queue` online while `COMFYUI_ROOT` lacked writable directories. Task `cb56041d-14b3-4edd-b625-7c41b68eb078` became `failed` with the unchanged input/output permission error | PASS (constructed stub) |
| Bad routing config | Invalid JSON did not fail the request; the previous valid Agnes decision remained active and an error log recorded `behavior: kept_last_valid_config` | PASS |

### Backoff and log-count proof

Two request-time `/system_stats` probes were logged, one for each created local task. The worker then performed four offline preflights during the observation window, not one every 1.5 seconds:

```text
2026-07-17T16:46:11.995Z
2026-07-17T16:46:43.600Z  (+31.605s)
2026-07-17T16:47:15.242Z  (+31.642s)
2026-07-17T16:47:46.886Z  (+31.644s)
```

Log counts for the run:

```text
[Worker] waiting_for_comfyui = 2 (one per task)
[ComfyPreflight:Result]     = 4
[TaskState:Failed]          = 0
[Worker] resumed            = 0 (ComfyUI intentionally stayed offline)
```

## Browser acceptance

The in-app browser used an isolated Vite/Express pair on ports `4200/4201`, a temporary copy of the database, a temporary uploads directory, and the same unreachable ComfyUI URL.

| Scenario | Evidence | Result |
| --- | --- | --- |
| Offline forced-local copy and button | Selecting `本地 ComfyUI` showed `本地 ComfyUI 未连接：任务将入队等待，启动后自动执行。`; `使用 ComfyUI 重新生成` reported enabled before the click | PASS |
| Real taskId warning | The click created task `3bdc3f9c-fd6b-47e0-ba18-ca895331fc2e`; the visible status was `任务已入队（...），但 ComfyUI 未连接，启动后才会开始执行。` | PASS |
| Persisted UI task state | The temporary DB recorded the same task as `pending / waiting_for_comfyui`, null error, null `submittedAt` | PASS |
| Advanced-action guard | Clicking `生成专属工作流并打开 ComfyUI` while offline produced the existing confirm guard and no additional task | PASS |
| Explicit-local source boundary | `src/App.tsx` still contains exactly two `forceProvider: 'comfyui_local'` sites (parameter dialog and advanced adjustment); the diff touches neither site nor the existing taskId branch | PASS (static) |

## Data and boundary audit

- The worktree contains neither `db.sqlite` nor `uploads/`.
- All acceptance writes went to `%TEMP%` databases/uploads; no real Agnes, Pollinations, Kling, or ComfyUI generation was invoked.
- The formal `C:\Users\Owner\Documents\GitHub\-\db.sqlite` had an unrelated active writer during acceptance, so a global byte-for-byte unchanged claim is not possible. Every server started here had `SQLITE_DB_PATH` pinned to a temporary file and therefore did not directly open the formal DB for writes.
- `config/imageGenRouting.json`, schema/migrations, dependencies, `server/modules/**`, components, and CSS were not changed.
- `server.ts` changes are confined to the approved generate-image enqueue region and worker submit/backoff region.

## Honest boundary / CC real-machine follow-up

`UNVERIFIED / 留 CC 真机`: starting a real ComfyUI after an offline wait and observing `[Worker] resumed` plus successful execution. A truthful local mock cannot prove this machine-specific path because the full preflight also validates process ownership, database lock state, and real input/output/user directory writability.

CC should run: real ComfyUI offline enqueue -> start the actual instance -> confirm one `resumed` log and task execution; then hot-toggle the real routing config and regress the parameter dialog/batch paths.
