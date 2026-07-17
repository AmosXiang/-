# Agnes Image UI Adaptation Acceptance Evidence

Date: 2026-07-16

Branch: `feat/agnes-image-ui-adapt`

Baseline: `e2ee9e16a2cb09bc89975462f4d7b9a7d417276b`

Worktree: `C:\Users\Owner\Documents\GitHub\wt-agnes-ui`

## Delivered scope

- Removed the single-shot UI's pre-submit ComfyUI runtime gate. The UI now submits `POST /api/generate-image` first and leaves provider selection to the server.
- Preserved the existing Agnes synchronous result and both 409 branches.
- Moved the ComfyUI runtime query into the returned-`taskId` branch:
  - disconnected: show `任务已入队（{taskId}），但 ComfyUI 未连接，启动后才会开始执行。` and do not poll;
  - connected: keep `任务已创建：{taskId}` and call `pollComfyTasks()`;
  - runtime query failure: surface the concrete error through the existing catch/feedback path.
- Removed the duplicate `setGeneratingShotIndex(idx)` call without adding state.
- Added the configured-routing explanation below the new-creation wizard's image-platform selector. It is present only while `imagePlatform === 'comfyui'` and explicitly says the server configuration remains authoritative.
- Did not change batch generation, either explicit `forceProvider: 'comfyui_local'` call, `applyAgnesShotImage`, any other platform branch, server/config code, CSS, components, or dependencies.

## Automated verification

```text
npm run lint
PASS: tsc --noEmit, 0 errors

npm run build
PASS: 2091 modules transformed, production bundle emitted
NOTE: Vite emitted only the existing large-chunk advisory.
```

All module tests were discovered recursively and passed together:

```powershell
$tests = Get-ChildItem 'server\modules' -Recurse -Filter '*.test.ts' |
  Sort-Object FullName |
  ForEach-Object { $_.FullName }
.\node_modules\.bin\tsx.cmd --test $tests
```

```text
PASS: 60 tests, 0 failures
```

Image-provider tests used the taskbook command:

```text
node --experimental-transform-types --test server/providers/imageGen/*.test.ts
PASS: 10 tests, 0 failures
```

No test invoked a real provider. The image-provider suite used its existing fixture provider.

## Browser and stub acceptance

The built UI was inspected in the in-app browser against an isolated database copy and a one-off localhost response stub. No stub file or test infrastructure was added to the repository.

| Scenario | Evidence | Result |
|---|---|---|
| Routing explanation | With `comfyui` selected, the exact route note had DOM count `1`; selecting `pollinations` changed it to `0`; selecting `comfyui` again restored it to `1`. A browser screenshot confirmed the note fits below the selector without horizontal overflow. | PASS |
| ComfyUI offline + empty shot -> Agnes synchronous result | Stub delayed the Agnes response. During the request, `重新生成静态画面` reported `enabledDuringRequest=false`. The result then produced an `img "分镜 27"` marker and status `图片已生成（Agnes 云端）。`. | PASS (stub) |
| ComfyUI offline + character shot -> taskId warning | Stub returned `stub-task-offline`, followed by `runtime.connected=false`. Visible status was `任务已入队（stub-task-offline），但 ComfyUI 未连接，启动后才会开始执行。`. A browser screenshot captured the warning feedback. | PASS (stub) |
| ComfyUI online + character shot -> taskId and polling | Stub returned `stub-task-online`, followed by `runtime.connected=true`. Visible status was `任务已创建：stub-task-online`. Stub events showed `POST /api/generate-image`, then `GET /api/comfyui/runtime`, then an immediate `GET /api/comfyui/tasks?projectId=1783192733645`. | PASS (stub) |
| Agnes duplicate request | Stub returned HTTP 409 with `provider: "agnes"`. Visible status was `该分镜已有 Agnes 生成进行中，请稍候再试。`. | PASS (stub) |
| Runtime query failure after taskId | Stub returned a taskId and then HTTP 500 from `/api/comfyui/runtime`. Visible status was the unmodified concrete error `stub runtime unavailable`. | PASS (stub) |
| Explicit local actions remain strict | Source still contains exactly the two intended `forceProvider: 'comfyui_local'` calls (parameter dialog and advanced adjustment), at the pre-existing source locations. The package diff does not touch either call or their guards. | PASS (static boundary proof) |

The existing `generatingShotIndex` state was reused for Agnes loading and reset by the existing `finally`; no new loading state was introduced.

## Real temporary-backend observation

Before enabling the response stub, the browser was also run against the real backend with:

```text
SQLITE_DB_PATH=C:\Users\Owner\AppData\Local\Temp\agnes-ui-adapt-019f6dff\db.sqlite
UPLOADS_DIR=C:\Users\Owner\AppData\Local\Temp\agnes-ui-adapt-019f6dff\uploads
DISABLE_COMFY_WORKER=true
COMFYUI_AUTOSTART=false
AGNES_API_KEY=
```

With ComfyUI offline, clicking the single-shot button did issue the network request and surfaced the backend response `ComfyUI 未连接：fetch failed`. This proves the old frontend pre-submit blocker is gone.

The real backend currently checks ComfyUI `/system_stats` before creating a local task (`server.ts` lines 7512-7518 on this baseline), so it returns 503 rather than a taskId while ComfyUI is offline. Consequently, the taskbook's offline-taskId warning row is stub-validated only; satisfying it against the real backend would require an out-of-scope server change, and `server/**` is explicitly forbidden in this package. CC should decide whether that backend contract mismatch needs a separate follow-up.

No real Agnes request was made. The real-backend run had an empty Agnes key, and all Agnes success/409 paths used the localhost stub.

## Data and boundary audit

- The acceptance server was pointed only at the temporary database copy and temporary uploads directory.
- All acceptance processes, the temporary data directory, and the temporary `node_modules` junction were removed after verification; ports 4174/4190/4191 had zero remaining listeners.
- The worktree contains neither `db.sqlite` nor `uploads/`.
- The formal uploads tree remained at 1000 files before and after the acceptance check.
- The main checkout's formal `db.sqlite` timestamp advanced from `2026-07-16 20:03:09 -07:00` to `2026-07-16 20:16:23 -07:00` while unrelated pre-existing services were listening on ports 3000/3001. This acceptance used ports 4174/4175 and later 4190/4191 with `SQLITE_DB_PATH` pinned to the temp copy, so it did not directly write the formal path; however, because of that concurrent external writer, a global byte-for-byte "formal DB unchanged" claim cannot be made.
- Browser screenshots were captured during acceptance but were not added to the repository because the task allowlist permits only `src/App.tsx` and this evidence document.
- `git diff --check` passed, and the final source boundary before evidence creation was only `src/App.tsx`.

## CC review handoff

CC should focus the line review and real-machine regression on:

- confirming the server routes a real empty shot to Agnes while ComfyUI is offline and the image lands on the card;
- deciding whether the real backend's offline ComfyUI 503 gate should remain or be changed in a separate server package;
- confirming the route explanation remains accurate when `autoRoute=false` is exercised;
- confirming the two explicit local operations still block while ComfyUI is offline;
- confirming batch generation remains ComfyUI-only and unchanged.

---

## CC 复核与真机回归增补（2026-07-16/17，CC 执行）

逐行 review PASS（范围审计：基线 e2ee9e1 起 diff 仅 App.tsx + 本文档；守卫下移、agnes 分支、taskId 后置 runtime 查询、重复 setGeneratingShotIndex 去重、选择器文案均符合任务书 §二/§三）。合并入 feature/camera-derive，lint PASS。

真机（ComfyUI 全程离线、真实 Agnes）：

| 场景 | 结果 |
| --- | --- |
| 空镜 #74 新 UI 点击生成 | 请求发出 → 真实 Agnes 同步 → 卡片落图（shot-73-02b482d3…png）→ 反馈「图片已生成（Agnes 云端）。」→ 审计字段 gen_provider=agnes/request_id 写入 |
| 含人物镜头 #16 点击生成 | 路由到 comfyui_local → 服务端 503 `COMFYUI_UNAVAILABLE` → 前端如实显示「ComfyUI 未连接：fetch failed」，零任务创建零污染（**Codex 指出的契约差异确认属实**：真实后端离线不入队而 503；"离线入队+警示"UI 分支现阶段仅 stub 可达，改服务端入队语义留待独立 server 包评估） |
| 路由说明文案 | comfyui 选项下正确渲染 |
| autoRoute=false 回退 | 改配置+**重启后**同样的空镜直调 → 503 走旧管线，零副作用；**配置在启动时读取，热改无效，切换必须重启**（真机实测确认）。验证后配置已还原 autoRoute=true |
| 副作用核点 | uploads/images/agnes/ 最终仅 2 文件（#72、#74 各一），无游离生成；config 还原后 git 干净 |

结论：适配包真机 **PASS**。遗留（不阻断）：①服务端"ComfyUI 离线入队"语义 → 独立 server 包待评估；②批量入口适配 → 后续包；③路由配置需重启生效 → 可在 server 包一并考虑热加载。
