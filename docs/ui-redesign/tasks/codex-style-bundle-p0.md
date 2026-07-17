# 任务书（Codex）：StyleBundle P0 · 双管线生成配方统一

> 全文直接粘贴给 Codex。上下文自包含。
> 定位（用户拍板）：当前 Agnes/ComfyUI 混合路由只是"生产效率路由"，不能承诺交付级风格统一。P0 不是"给 Agnes 塞一句 overlay"，而是**让两条管线消费同一份生成配方（StyleBundle）**，并让 Agnes 图片具备快照与契约版本追踪——这是后续 P1 风格锚图（IPAdapter + referenceImages A/B）不悬空的地基。
> 背景代码事实（CC 已逐处核实）：
> ①ComfyUI shot/main 路径注入项目 style overlay（框架语 "style only; preserve shot content and composition"）与场景 overlay（框架语 "environment only; preserve shot content, composition and characters"），双重注入有 `includes` 去重守卫；锁定契约（version≥1）接管 preset/尺寸/LoRA（server.ts L7205-7232、L7260+）；
> ②Agnes 路径只拿到 `optimizePrompt(req.body.prompt, false, req.body.style)`（imageGen/routes.ts L143），**项目/场景 overlay 均未注入**；
> ③**Agnes 无视契约尺寸**：`width/height = req.body?.width || 1024`（routes.ts L148-149），前端不传宽高 → 恒为 1024×1024，契约画幅在该路径失效；
> ④Agnes 无生成快照、无契约版本记录：saveAudit 只写 gen_provider/request_id/route_reason（routes.ts L51-79），契约改版后 Agnes 图无法判断是否过期（ComfyUI 侧有 comfyui_tasks.generationSnapshotJson + isStale 体系）；
> ⑤风格契约有整数 `version` 字段（0=未锁草稿，≥1=已锁），`resolveEffectiveStyleContract` 返回 version/styleOverlay/storyboardPresetId/宽高/LoRA；场景经 `sceneForShot(project, shotId)` 取 `overlay` 与 `id`。
> 分工：本包归你（coding+验证+提交）；CC 负责 server.ts 一处 deps 接线、逐行 review、真机双管线回归。
> 基线 `feature/camera-derive@f996ef3`。分支：`git worktree add -b feat/style-bundle-p0 ../wt-style-bundle f996ef3`（强制独立 worktree）。

## 一、范围拍板（越界即返工）

**做**：①StyleBundle 类型与组装（imageGen 模块内）；②Agnes 路径消费 bundle：项目/场景 overlay 注入（与 ComfyUI 逐字同框架语+同去重语义）、契约尺寸继承；③Agnes 生成快照 + `gen_style_contract_version` 版本追踪；④测试全覆盖。
**不做**：风格锚图/referenceImages 接入（P1，需先 A/B 验证语义）、ComfyUI 管线任何改动（server.ts 禁碰——其注入逻辑是本包的"对齐基准"而非改造对象）、定稿门/离群检查（P2）、前端改动（宽高由服务端 bundle 决定，不经前端）。

## 二、deps 扩展（注册形状，CC 接线）

```ts
// registerImageGenRouting(options) 追加可选项；缺席时 Agnes 路径行为与现状完全一致（仅打一条 warn），不 503
resolveStyleContext?: (projectId: string, shotId: string) => {
  contractVersion: number;          // resolveEffectiveStyleContract().version（0=草稿）
  styleOverlay: string;             // 可空串
  sceneId: string | null;
  sceneOverlay: string;             // 可空串
  width: number;                    // 契约有效尺寸（草稿态也有派生值）
  height: number;
  presetId: string | null;          // 契约 storyboardPresetId（记录用，Agnes 不消费）
  loraStrength: number | null;      // 同上，记录用
} | null;                           // 项目不存在等异常返回 null
```

模块自身不 import style-contract/scene-reference（模块边界归 CC 在 server.ts 用现成导出组装）。

## 三、StyleBundle 组装与 Agnes 消费（`server/providers/imageGen/**`）

1. 新文件 `styleBundle.ts`：纯函数 `composeAgnesPrompt(basePrompt, bundle)` 与 `buildStyleBundle(context)`——把注入规则收敛成可单测的纯逻辑。
2. **注入规则（与 ComfyUI 逐字对齐，这是"同一配方"的含义）**：
   - 项目 overlay 非空且 `!prompt.includes(overlay)` → 追加段落 `Project art direction style overlay (style only; preserve shot content and composition): ${overlay}`；
   - 场景 overlay 非空且未含 → 追加 `Scene reference (environment only; preserve shot content, composition and characters): ${sceneOverlay}`；
   - 框架语字符串**必须与 server.ts 现行文本逐字一致**（测试断言字面量）；注入发生在 `optimizePrompt` 之后（与 ComfyUI 顺序一致：先优化译文、后拼 overlay）。
   - version 0 草稿态同样注入（对齐 ComfyUI 现行为：overlay 注入不以锁定为前提，锁定只管 preset/尺寸接管）。
3. **尺寸继承**：`req.body` 未显式给宽高时，Agnes 生成使用 bundle 的 width/height；显式给了则尊重请求（保留调试口）。bundle 缺席 → 维持现状 1024 缺省。
4. `resolveStyleContext` 抛错/返回 null → 打结构化 warn（`style_context_unavailable`），按缺席路径继续——风格上下文失败不得阻断生成。

## 四、快照与版本追踪（零迁移）

1. saveAudit 现已回写 shot JSON（gen_provider 等，routes.ts L51-79 同位置）：**追加可选字段** `gen_style_contract_version: number`（bundle 缺席时不写）。铁律 6 合规（Shot 可选 JSON 字段，旧数据零迁移；不加表不加列）。
2. audit 行 `raw_meta`（既有 8k JSON 槽）追加 `styleBundle` 摘要：`{ contractVersion, sceneId, styleOverlayLen, sceneOverlayLen, width, height, presetId, loraStrength, injected: { style: boolean, scene: boolean } }`——**不放全量 prompt**（8k 上限），长度+布尔足以审计注入是否发生。
3. 响应体追加 `styleContractVersion`（前端暂不消费，为 P2 定稿门与调试留口）。

## 五、验证与验收

- 单测（styleBundle.ts 纯函数 + routes 集成，stub resolveStyleContext）：
  | 用例 | 期望 |
  |---|---|
  | 双 overlay 注入 | 最终 prompt 含两段框架语（字面量断言），顺序=优化文→项目→场景 |
  | overlay 已含于 prompt | 不重复注入（对齐 comfy `includes` 语义） |
  | overlay 空串 / 场景缺席 | 对应段落不出现 |
  | version 0 草稿 | 照常注入，`gen_style_contract_version=0` 写入 |
  | 尺寸继承 | 未传宽高 → 契约宽高进 provider 请求；显式传 → 尊重请求 |
  | resolveStyleContext 缺席/抛错/null | 行为=现状（1024 缺省、无注入、无版本字段），有 warn，无 5xx |
  | 快照 | shot JSON 得 `gen_style_contract_version`；audit raw_meta 含 styleBundle 摘要且总长 ≤8k |
  | forceProvider=comfyui_local / 旧管线直通 | 零变化（bundle 只挂 Agnes 分支） |
- `npm run lint` + `npm run build` + 模块测试（70/70 不回归）+ imageGen 测试（11/11 + 新增）。
- 全程 stub，零真实计费；正式 db/uploads 零污染。
- 证据：`docs/ui-redesign/tasks/evidence/style-bundle-p0-acceptance.md`。

## 六、边界（违反即返工）

- **允许改动**：`server/providers/imageGen/**` 及其测试、证据文档——此外零改动。
- **禁碰**：server.ts（deps 接线归 CC）、server/modules/**（style-contract/scene-reference 只经 CC 接线间接消费）、src/**、config/**。
- 不建表、不改 schema、不加依赖。提交前缀 `feat(style-bundle): ...`，不 push，完成通知 CC。

## 七、CC 后续（非 Codex 范围）

server.ts 接线 `resolveStyleContext`（resolveEffectiveStyleContract + sceneForShot 组装，try/catch 返 null）。真机：空镜 Agnes 生成 → 检查 prompt 注入日志、契约尺寸生效（实测响应图尺寸 vs 1024 旧值）、shot JSON 版本字段、契约改版后新旧图版本可区分；ComfyUI 侧零回归抽查。**P1 前置调研另行**：Agnes referenceImages 语义 A/B（锚图是否复制主体/构图）、ComfyUI 预设的 IPAdapter 节点映射能力。
