# 任务书（Antigravity）：P4b 交付包 scenes/ 目录 + WP-P4 跟进三项（WP-J）

> 全文直接粘贴给 Antigravity。上下文自包含。
> 方案依据：`integration-plan-2026-07-14.md` 裁决 #9（"scenes/ 等场景资产落地后"——P3.5 正在落地）+ WP-P4 CC review 的三项非阻断跟进。
> 你的范围限 `server/modules/export-deck/`（你建的模块）。同期 Codex 在做场景参考数据模型（WP-I），**数据契约见下、已锁定**；两包可并行——你必须防御式读取（字段缺失=功能静默跳过），不依赖 WP-I 先合并。
> 基线 `feature/camera-derive@325f2ba`。分支：`git worktree add -b feat/export-scenes-p4b ../wt-export-scenes-p4b 325f2ba`。
> **纪律重申**：强制上述 worktree，禁止在主工作区操作；视觉/行为验收以复核方（CC）为准，自报 PASS 不作数。

## 一、数据契约（WP-I 落地的形状，锁定；读取必须防御式）

```ts
// GeneratedScriptRecord.sceneReferences —— 可能不存在(旧数据/WP-I 未合并)
sceneReferences?: Array<{
  id: string; name: string;
  imageUrl?: string;   // /uploads/... 可无
  overlay?: string;    // 可无
  updatedAt: string;
}>;
// Shot.sceneId?: string
```

## 二、任务 1：交付包 scenes/ 目录

`server/modules/export-deck/routes.ts` 导出流程内（characters/ 处理之后）：

1. 读 `script.sceneReferences`；**字段缺失或空数组 → 完全跳过（不建空目录），README 场景节写"本项目未使用场景参考"**；
2. 有场景时建 `scenes/`，每场景有可读参考图则拷入，命名 `NN_<sanitizeFilename(name)><ext>`（复用你现有的 `getLocalPath` 越界防护与 `isReadableFile`）；无图场景不拷文件但进 README 清单标 `(无参考图)`；
3. `README.txt` 增第 3.5 节「场景参考清单」：每场景一行（名称、有无图、overlay 前 60 字符）+ 目录用途说明；
4. `storyboard-manifest.json`（generator.ts `generateManifest`）增 `scenes` 数组：`{ id, name, imageFile: "scenes/NN_xxx.png" | null, overlay: string | null }`，并给每个 shot 条目透传 `sceneId ?? null`；
5. 递归 zip 已有，无需改（新目录自动进包）。

## 三、任务 2：WP-P4 跟进三项（CC review 2026-07-15 提出）

1. **测试补强**（`routes.test.ts`）：
   - 角色 `front/side/back` 三视图从 `views.*` 直接 URL 导出；
   - `viewGenerations.<view>.imageUrl` 回退链（`views` 缺失时生效）；
   - 越界路径（如 `/uploads/../secret.png`）被拒且导出不崩溃、README 标 missing；
   - 缺失视图在 README 正确列出；
   - 新增 scenes/：有图/无图/字段缺失三态 + manifest scenes 数组断言。
2. **Unicode 健壮性**：`sanitizeFilename` 由 `[^一-龥a-zA-Z0-9_\-]` 放宽为 Unicode 字母/数字（建议 `/[^\p{L}\p{N}_\-]/gu`，保测试通过与 Windows 文件名安全——`\p{L}` 不含 `/\:*?"<>|` 等保留字符，天然安全）；`truncateRole` 的 `.slice(0,14)` 改 `Array.from(text).slice(0,14).join('')`（防切开 emoji 代理对）。均需测试用例（日文假名目录名、含 emoji 的 role）。
3. **中文角色名 zip 一次性核验**：在 db 副本上对含中文角色名的真实项目（如「孤岛豪宅」的 梅/雷恩）导出，Windows 资源管理器解压，确认 `characters/01_梅/` 目录名不乱码；截图进证据文档。

## 四、测试与验收

- `npx tsx --test server/modules/export-deck/routes.test.ts` 全过；`npm run lint`、`npm run build` 过；
- db 副本真实导出一次：zip 解包目录树 + README 全文 + manifest scenes 节选进证据；
- 证据：`docs/ui-redesign/tasks/evidence/export-scenes-p4b-acceptance.md`（含 §三.3 解压截图）。

## 五、边界（违反即返工）

- 只许触碰：`server/modules/export-deck/*` + 证据文档；**server.ts/App.tsx/types.ts/其他模块一律禁碰**（`sceneReferences` 的 types.ts 字段由 WP-I 提交，你的代码用 `(script as any).sceneReferences` 或本模块局部类型防御式读取）；
- 不建表、不加依赖、正式 db.sqlite 与正式 uploads 零污染；
- 提交前缀 `feat(export-deck): ...` / `fix(export-deck): ...` / `test(export-deck): ...`，不 push，完成后通知 CC review。
