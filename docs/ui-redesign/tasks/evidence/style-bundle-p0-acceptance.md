# StyleBundle P0 验收证据

日期：2026-07-17
基线：`feature/camera-derive@f996ef3`
实现分支：`feat/style-bundle-p0`
独立 worktree：`C:\Users\Owner\Documents\GitHub\wt-style-bundle`

## 结论

PASS。Agnes shot 路径现在与 ComfyUI shot/main 使用同一份项目/场景风格语义：先优化 prompt，再按项目 overlay、场景 overlay 的顺序注入完全相同的框架语；请求未显式给尺寸时继承有效风格契约尺寸。成功结果把契约版本写入 shot JSON，并在既有 audit `raw_meta` 中保存不含完整 prompt 的 StyleBundle 摘要。ComfyUI 分支未消费 bundle，既有直通行为不变。

P1 `referenceImages`/IPAdapter、前端、定稿门、schema 和依赖均未改动。

## 实现范围

- 新增 `server/providers/imageGen/styleBundle.ts`
  - `buildStyleBundle`
  - `composeAgnesPrompt`
  - `summarizeStyleBundle`
  - `appendStyleBundleSummary`
- 修改 `server/providers/imageGen/routes.ts`
  - deps 新增可选 `resolveStyleContext`
  - 仅 Agnes 分支解析/消费 bundle
  - resolver 缺失、返回 null 或抛错时输出单条 `style_context_unavailable` warn，并按旧行为继续
  - bundle 缺失且 Agnes 成功重生时移除可能残留的旧 `gen_style_contract_version`
  - audit 超过 8 KiB 时保留合法 JSON、StyleBundle 摘要和截断标志
- `server.ts` 只改 `registerImageGenRouting({...})` 注册点，复用既有 `resolveEffectiveStyleContract` 与 `sceneForShot`；无新增 import。
- 新增纯函数测试并扩展 imageGen 路由集成测试。

## 自动化验证

| 命令 | 结果 |
|---|---|
| `tsx --test server/providers/imageGen/styleBundle.test.ts server/providers/imageGen/routes.test.ts` | PASS，15/15 |
| 全部 `server/providers/imageGen/*.test.ts` | PASS，19/19，0 fail |
| 全部 `server/modules/**/*.test.ts` | PASS，70/70，0 fail |
| `npm run lint` | PASS |
| `npm run build` | PASS；仅既有 Vite 大 chunk warning |
| `git diff --check` | PASS |

覆盖点：

- 优化后 prompt → 项目 overlay → 场景 overlay 的字面量与顺序；
- 与 ComfyUI 相同的 `includes` 去重语义；
- 空 overlay/无场景不注入；
- version 0 草稿照常注入并记录 `gen_style_contract_version=0`；
- 未传尺寸继承契约，显式尺寸覆盖契约；
- resolver 缺失/null/抛错均保持 1024 旧缺省、无注入、响应无版本字段、shot 不残留旧版本字段、无 5xx；
- 8 KiB audit 截断后仍为合法 JSON 且保留 StyleBundle 摘要；
- `forceProvider=comfyui_local` 不调用 resolver、不触碰 Agnes provider。

## 真实 server.ts 隔离接线验收

采用临时 SQLite、临时 uploads、随机回环端口和本机假 Agnes HTTP 服务启动真实 `server.ts`：

- `SQLITE_DB_PATH`：系统临时目录内随机路径；
- `UPLOADS_DIR`：同一随机临时目录；
- `DISABLE_COMFY_WORKER=true`；
- `AGNES_BASE_URL=http://127.0.0.1:<random>/v1`；
- 假 provider 返回本机 1×1 有效 PNG，零真实 API 请求、零计费。

临时项目数据：契约 version=7、项目 overlay=`wire project teal grain`、场景 overlay=`wire harbor sodium fog`、尺寸 640×384、preset=`wire-preset`、LoRA=0.42。

最终结果：

```json
{
  "status": "PASS",
  "providerRequest": {
    "model": "agnes-image-2.1-flash",
    "prompt": "empty harbor at dawn\n\nProject art direction style overlay (style only; preserve shot content and composition): wire project teal grain\n\nScene reference (environment only; preserve shot content, composition and characters): wire harbor sodium fog",
    "size": "640x384"
  },
  "response": {
    "provider": "agnes",
    "requestId": "wire-request-1",
    "styleContractVersion": 7
  },
  "shotVersion": 7,
  "auditStyleBundle": {
    "contractVersion": 7,
    "sceneId": "wire-scene",
    "styleOverlayLen": 23,
    "sceneOverlayLen": 22,
    "width": 640,
    "height": 384,
    "presetId": "wire-preset",
    "loraStrength": 0.42,
    "injected": { "style": true, "scene": true }
  },
  "localImageSaved": true
}
```

真实日志同时出现：

- `[ImageGenRouter] event=route_selected provider=agnes`
- `[AgnesClient] event=image_request size=640x384`
- `[AgnesImageProvider] event=image_saved bytes=91`

首次隔离运行已经到达 `image_saved`，但最后的临时 SQLite 检查脚本被 PowerShell 参数引号破坏而失败；进程和临时目录正常清理。改为 base64 传递只读检查脚本后，完整闭环重跑 PASS。该失败属于验收脚手架，不是产品路径失败。

两次运行均在 `finally` 中停止精确 PID，并校验目标处于系统临时目录后递归清理。正式 `db.sqlite`、正式 `uploads/` 与真实 Agnes 均未触碰。

## 边界审计

- `server.ts` diff 只有 `registerImageGenRouting` 调用点一个 hunk；
- imageGen 模块没有直接 import `style-contract` 或 `scene-reference`；
- 未修改 `server/modules/**`、`src/**`、`config/**`；
- 未建表、未改 migration/schema、未新增依赖；
- 未运行真实 provider，未 push。
