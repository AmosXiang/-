# P3.5 Scene Reference Acceptance Evidence

Date: 2026-07-15

Branch: `feat/scene-reference`

Baseline: `325f2ba`

Worktree: `C:\Users\Owner\Documents\GitHub\wt-scene-reference`

## Delivered scope

- Added the locked store-JSON data contract: `GeneratedScriptRecord.sceneReferences[]` and `Shot.sceneId`.
- Added the isolated `server/modules/scene-reference/` module with list replacement, upload, shot tagging, validation, and machine-readable errors.
- Added post-optimization scene-overlay injection for `shot/main` generation and scene data in `generationSnapshotJson`.
- Added `SceneReferencePanel`, Inspector scene tagging, and the Inspector read-only scene label.
- Completed the three P3 follow-ups: null normalization, shared negative-prompt constant, and accurate modal copy.
- Did not add a table, dependency, scene workshop, or image-conditioning path.

## Automated verification

All seven existing/new test groups were run together:

```text
npx tsx --test \
  server/constants/cameraVocab.test.ts \
  server/modules/camera-derive/workflow.test.ts \
  server/modules/export-deck/routes.test.ts \
  server/modules/scene-reference/routes.test.ts \
  server/modules/shot-review/routes.test.ts \
  server/modules/story-version/routes.test.ts \
  server/modules/style-contract/routes.test.ts

PASS: 43 tests, 0 failures
```

The five scene-reference module tests cover:

- legacy empty list and project 404;
- UUID fill, blank-name rejection, 20-scene limit, and forged `imageUrl` rejection;
- multipart image write under an isolated `scene-refs/` directory and persisted URL update;
- valid tag, unknown-scene 422, and null removal;
- deletion orphan count without cascading `shot.sceneId` changes.

Static gates:

```text
npm run lint
PASS: tsc --noEmit, 0 errors

npm run build
PASS: 2087 modules transformed
```

Vite emitted only the existing large-chunk advisory.

## Database-copy HTTP acceptance

The formal database was copied to:

```text
C:\Users\Owner\Documents\GitHub\wt-scene-reference\.tmp\p35-acceptance.sqlite
```

The isolated server used port `3021`, `DISABLE_COMFY_WORKER=true`, a temporary uploads directory, and a local health-only stub on port `18188`. All temporary files, logs, uploads, and processes were removed after acceptance.

Fixture project: `1784156991380-808d3c8f`

Contract and scenes:

```json
{
  "styleContract": {
    "version": 1,
    "locked": true,
    "storyboardPresetId": "pure_klein",
    "styleOverlay": "cinematic noir lighting",
    "width": 832,
    "height": 576,
    "loraStrength": 0.65
  },
  "scenes": [
    {
      "id": "scene-hall",
      "name": "Mansion Hall",
      "overlay": "dark oak walls, rain-streaked windows, antique brass lamps"
    },
    {
      "id": "scene-garden",
      "name": "Garden",
      "overlay": ""
    }
  ]
}
```

Three real `POST /api/generate-image` enqueue requests produced:

| Shot | Scene state | Scene phrase count | Stored preset | Size | LoRA |
|---|---|---:|---|---|---:|
| `scene-shot-1` | `scene-hall`, overlay present | 1 | `01_klein_character_master` | 832×576 | 0.65 |
| `scene-shot-2` | untagged | 0 | `01_klein_character_master` | 832×576 | 0.65 |
| `scene-shot-3` | `scene-garden`, empty overlay | 0 | `01_klein_character_master` | 832×576 | 0.65 |

The tagged task prompt was:

```text
A traveler enters the mansion hall.

Project art direction style overlay (style only; preserve shot content and composition): cinematic noir lighting

Scene reference (environment only; preserve shot content, composition and characters): dark oak walls, rain-streaked windows, antique brass lamps
```

The three task snapshots stored these scene values:

```json
[
  {
    "targetId": "scene-shot-1",
    "scene": {
      "id": "scene-hall",
      "overlay": "dark oak walls, rain-streaked windows, antique brass lamps"
    }
  },
  {
    "targetId": "scene-shot-2",
    "scene": null
  },
  {
    "targetId": "scene-shot-3",
    "scene": {
      "id": "scene-garden",
      "overlay": ""
    }
  }
]
```

Every snapshot also retained the effective locked style-contract values and the actual seed.

## Data and safety boundaries

- Scene data remains inside the existing `generated_scripts` JSON document.
- Upload URLs can only be changed through the upload endpoint; list PUT rejects forged or changed values.
- Removing a scene does not mutate shot tags and reports `orphanedShotCount`.
- Missing scenes and empty overlays silently skip generation injection.
- Uploaded scene images are not used as ComfyUI conditioning inputs in this package.
- Formal `db.sqlite` and formal `uploads/` were not used for writes.

## Review handoff

CC should perform the required real-browser acceptance, focusing on:

- add/edit/delete/save and image-upload failure states in `SceneReferencePanel`;
- scene dropdown state in Inspector zone 1;
- current-scene read-only line in zone 3;
- absence of horizontal overflow at the 280px Inspector width;
- generated-project-only mounting and legacy projects with no scene fields.
