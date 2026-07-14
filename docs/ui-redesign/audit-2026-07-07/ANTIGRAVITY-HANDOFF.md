# UI_REDESIGN_V2 — Antigravity Handoff

## Target and constraints

- Repository: `C:\Users\Owner\Documents\GitHub\-`
- Stack: React/TypeScript/Vite frontend, Express/TypeScript backend, SQLite store.
- Preserve `db.sqlite`, `uploads/`, ComfyUI workflows 01–04, queue core behavior, existing export/generation paths, and the identityPrompt/LLM optimization separation.
- The working tree was already dirty before UI_REDESIGN_V2. Do not reset it or commit all modified files wholesale.
- `.codex-ui-v2-baseline.patch` is a snapshot of the pre-UI_REDESIGN_V2 diff for the four primary files. Use it to distinguish earlier user changes from the V2 additions. It is temporary and should not be committed.

## Confirmed design direction

- Overall shell: option 1, production command center.
- Center editor: option 2, large shot canvas plus structured inspector.
- Task center: option 3 failure triage only.
- Left rail always means resource/project library. Top navigation means project stages/views. No duplicate navigation.
- Required audit/evidence folder: `docs/ui-redesign/audit-2026-07-07/`.

## Work already present

### Schema and backend

- `src/types.ts` has optional enrichment fields for backwards-compatible reads: `camera`, `framing`, `blocking`, `durationSec`, `provenance`.
- `server.ts` defines fixed enum lists, `VIDEO_PROVIDER_CONFIG`, `assertStoryboardEnrichment`, and exported pure `buildVideoPrompt`.
- Gemini `/api/analyze` schema requires enrichment fields and validates `provenance === analyzed`; creative script generation requires and validates `ai_optimized`. Validation errors are explicit `STORYBOARD_SCHEMA_INVALID`; there is no silent defaulting.
- Dedicated edited-write endpoint: `PUT /api/generated-scripts/:id/shots/:shotId/storyboard`. It forces and validates `provenance: edited`.
- Optimized-prompt persistence marks `provenance: ai_optimized`.
- Prompt preview endpoint: `POST /api/video-prompt/preview`.
- `/api/generate-video` resolves the stored shot through the same `buildVideoPrompt`, rejects invalid duration/schema with 422, uses the resolved prompt for Kling, and logs `[VideoPrompt:Resolved]` with exact prompt/native params/delivery notes.
- Public Comfy task payload now adds `failReason` (`timeout`, `lost_queue`, `param_error`, `missing`, `unknown`) and keeps `errorMessage`.

### Frontend

- `StoryboardInspector` exists near the top of `src/App.tsx` with structured controls for camera move/speed/note, framing, character blocking, duration, server-backed read-only prompt preview, and CAM/FOV P2 placeholder.
- Legacy shots are not silently enriched. The inspector shows an explicit initialization action that persists an `edited` shot.
- Kling duration is limited to 10 seconds in the editor. Seedance config exists server-side with a 12-second limit, but provider selection is not wired in the UI yet.
- Global red failure pill and task-center drawer exist. It groups tasks by `failReason`, shows raw errors/timestamps, and uses the existing retry endpoint for individual/group/all retry. “Change parameters” returns to the affected shot.
- Wizard mode now uses the normal video/project library sidebar (`false ? (...)` currently disables the duplicate wizard nav branch). Replace this temporary expression with clean JSX before final handoff.
- Character and narrative pages hide the duplicate right inspector via the conditional `admin-inspector` class.
- Step 3 has filters (`all`, `missing`, `failed`, `confirmed`), select-all-filtered state, and batch actions for speed, duration, regeneration, and confirmation.
- Step 4 computes export preflight failures and exposes action links for missing images, invalid duration, and incomplete enrichment.
- Typography utility tokens and inspector/task-center styles were added in `src/index.css`.

## Current verified status

- `npm run lint` / `tsc --noEmit`: PASS after the interrupted session.
- No production build was run after the latest JSX/CSS edits.
- No browser/design QA was run.
- No real Gemini analysis, Kling video generation, Comfy retry, or export action was executed for V2.
- No acceptance logs exist yet. Do not claim prompt byte equality or retry state-flow acceptance until real calls are captured.
- No V2 commits were created.

## Important incomplete/risky items

1. Run `npm run build` immediately. Fix any build-only issues.
2. `StoryboardInspector` currently writes on every control change. Add debounce/optimistic save state to avoid overlapping PUTs and stale response ordering.
3. Character binding can change without synchronizing `blocking`. Add explicit validation/action: every bound character needs one blocking row; unbound character rows must be rejected or removed explicitly.
4. Batch selection currently selects all filtered rows; individual visible checkbox/toggle UX still needs completion.
5. Batch operations use `Promise.all`; switch to a controlled sequence/result report so partial failures are visible and no validation error is swallowed.
6. Wire provider selection/config into the editor. The inspector is currently hard-coded to `provider="kling"`.
7. Verify both video endpoints. The current UI calls `/api/generate-video`; `/api/generate-animation` is older and may still bypass `buildVideoPrompt`. Either route it through the builder or prove it is unused.
8. The actual request still sends the legacy `prompt: shot.description` field from the frontend. The server ignores it and resolves the stored prompt; remove the field to make the contract unambiguous.
9. Finish center tabs (Script/Image/Video). `workspaceTab` state exists but is not fully wired to visible panels.
10. Finish single-primary-CTA cleanup. Old top step controls and per-format export buttons still exist; the export button is not yet disabled by `preflightPassed`.
11. Step 4 preflight action uses a timeout to call batch generation after switching step/state. Replace with an explicit queued action so stale `regenerateMode` cannot be used.
12. Remove all remaining visible `text-[8px]`, `text-[9px]`, `text-[10px]`, and `text-[11px]` from active UI paths or map them to the 12/13/14/16/20 token set. Requirement: body text >=13px.
13. Clean the temporary `false ? (...)` navigation branch rather than leaving dead JSX.
14. Add unit tests for `buildVideoPrompt`, provider duration limits, text fallback/native params, schema rejection, and failReason classification. Importing `server.ts` starts the server, so either extract pure logic to a testable module with a re-export from `server.ts`, or add a safe main-entry guard.
15. Add server-side validation that user-edited shot writes cannot reference unknown character IDs and that `at_character:<id>` targets exist.
16. Confirm strict Gemini schema enum support in the installed `@google/genai` version with a real analysis call.
17. Preserve existing unrelated changes in `.env.example`, diagnostics, Comfy health files, video POCs, docs, and acceptance artifacts.

## Required real acceptance evidence

Save all evidence under `docs/ui-redesign/audit-2026-07-07/`:

1. `npm run lint` and `npm run build` logs.
2. Browser screenshots for analysis, characters, narrative, structured shot editor, task center, and export preflight at the same desktop viewport.
3. One real structured shot PUT response showing `provenance: edited`, plus refresh proving persistence.
4. One real Gemini analysis response showing `provenance: analyzed`, and one optimization write showing `ai_optimized`.
5. One real video generation: capture preview response, `[VideoPrompt:Resolved]`, and outbound provider payload; compare prompt bytes exactly.
6. Duration-over-limit attempt proving HTTP 422 and no provider queue submission.
7. Real failed Comfy task payload showing `failReason`, retry request, and subsequent status transition.
8. Export preflight blocked state plus a successful export after all gates pass.
9. `design-qa.md` with reference/current screenshots and `final result: passed` before handoff.

## Commit strategy

The user requested separate commits for schema, layout, editor, task center, and preflight. Because the same files had pre-existing modifications, do not use `git add server.ts src/App.tsx ...` blindly. Stage only V2 hunks and inspect `git diff --cached` before every commit. Recommended order:

1. `feat(storyboard): add structured enrichment schema and video prompt builder`
2. `feat(ui): separate resource navigation from project stages`
3. `feat(storyboard): add structured shot inspector and batch editing`
4. `feat(tasks): add categorized failure center and queue retries`
5. `feat(export): add storyboard export preflight gates`
6. `docs(ui): add V2 implementation and acceptance evidence`

Do not commit until the corresponding slice builds and its cached diff contains no pre-existing work.
