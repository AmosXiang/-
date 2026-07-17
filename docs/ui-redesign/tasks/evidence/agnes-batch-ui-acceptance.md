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

---

## CC 复核与真机回归增补（2026-07-17，CC 执行）

逐行 review PASS（范围审计：diff 仅 App.tsx + 本文档；`buildShotImageRequestBody` 提取后单镜/批量共用零漂移逐字段核对；runId+stop ref 生命周期、`applyAgnesShotImage` 返回更新引用穿线避免陈旧状态、按钮态矩阵均符合任务书）。合并后 lint PASS。

真机（ComfyUI 全程离线、真实 Agnes、项目 1783192733645）：

| 场景 | 结果 |
| --- | --- |
| 契约未锁 + 离线 missing | 既有 alert 分支真机命中（原生弹窗如期阻断，矩阵最后一行 PASS） |
| 离线 failed / all 模式 | 按钮置灰 + 新 tooltip「该模式需本地 ComfyUI；缺失镜可离线经 Agnes 批量生成」 |
| 预检确认层 | 三数字分开：可经 Agnes 生成 9 镜 / 跳过 39 镜（需本地 ComfyUI）/ 预计 9×45s=405s 串行 |
| 串行真跑 + 进度 | 第 1 镜（#27）真实 Agnes 同步落图落卡，进度反馈「Agnes 批量：1/9 完成，0 失败」 |
| **真实失败不中断（非 stub）** | 第 2 镜（#37，描述含"血迹"）被 Agnes 内容审核真实拒绝（HTTP 502 "Unable to generate this content"）→ 记入失败明细、审计 provider_error 持久化、循环继续 |
| 停止 | 进行中点「停止 Agnes 批量」→ 当前镜完成后停，汇总「已中止：完成 1 / 失败 1 / 跳过 39」+ 逐镜失败明细，按钮复位可再次发起 |
| 落库核验 | shot#27 imageUrl+gen_provider=agnes 写入；#37 无图但 provider_error 审计在案；uploads/images/agnes/ 共 3 文件与预期一致 |

验证脚手架与数据卫生：项目契约本为未初始化，验证前快照 styleContract/comfyuiPreferences/artDirection 三字段 → 用系统建议初稿临时初始化+锁定 → 验证完成后停服对 store JSON 手术还原（契约回到 initialized:false/version 0，write-through 副作用字段复原），**批量产出的 #27 分镜图保留**（缺失分镜的正向补全，非污染）。

真机新知：Agnes 图片有内容审核，含血腥词汇的分镜描述会被拒（悬疑/惊悚题材批量时失败率不可忽视）——失败明细+审计已能承接，暂无行动项。

结论：批量适配包真机 **PASS**。在线 ComfyUI 回归项（本机 ComfyUI 未运行）留待下次 ComfyUI 可用时顺带抽查，风险低（在线路径 diff 仅按钮分派一层，generate-all 主体未动）。
