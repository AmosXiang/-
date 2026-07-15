# 任务书（Codex）：P2a 故事版本后端 + 故事编辑器/定稿面板组件（WP-E）

> 全文直接粘贴给 Codex。上下文自包含。
> 方案依据：`docs/ui-redesign/workflow-redesign-2026-07-14.md` §四 + `docs/ui-redesign/tasks/integration-plan-2026-07-14.md` 裁决 #1/#2（故事/分镜版本分离，故事编辑器砍到三块）。
> 基线：`feature/camera-derive@0864af3`（P1b 已合入）。分支：`feat/story-version`。**强制独立 worktree**（你上次的做法就是对的，保持）。

## 背景与核心原则

故事大纲是"发生什么"，分镜是"怎样拍出来"——**两者版本分离**。用户修改故事时绝不能覆盖或重生成已手工调整的分镜；只能把受影响分镜标记为"基于旧输入"（`isStale`，你在 WP-B 已实现该字段与 mark-stale API），由用户自行决定是否重生成。故事以 beat sheet 结构化存储，每次保存产生递增版本号，历史版本不可变。

本任务扩大了你的授权范围：除后端模块外，**两个新建前端组件文件也归你**（项目前端热区 App.tsx/index.css/router.ts 仍禁碰——组件由协调人 CC 负责接线挂载）。

## 一、数据模型（GeneratedScriptRecord 上的可选 JSON 字段，store 文档内，禁止建表）

```ts
// src/types.ts — GeneratedScriptRecord 追加（你提交）
storyDraft?: {
  logline: string;                                              // 一句话故事
  beats: Array<{ id: string; title: string; summary: string }>; // 三幕/beat 列表(有序)
  hooks: Array<{ id: string; time: string; label: string }>;    // 爽点时间轴(time 如 "00:20")
};
storyVersion?: number;   // 当前版本号,从 1 起
storyVersions?: Array<{  // 版本快照(含当前版;只增;最多保留最近 10 个,裁剪最旧)
  version: number;
  savedAt: string;       // ISO8601
  note?: string;
  storyDraft: NonNullable<GeneratedScriptRecord["storyDraft"]>;
}>;
```

**版本语义（锁定，2026-07-15 契约修订）**：每次 PUT/rollback 都把**新版本快照**追加进
`storyVersions`（含 note 与 savedAt）；`storyDraft`/`storyVersion` 只是**当前版本的快捷镜像**。
因此首次保存后 `storyVersions = [v1 快照]`，`GET /versions/1` 立即可用，历史列表含当前版。
旧项目无这些字段 = 未初始化，必须优雅处理。

## 二、后端模块 `server/modules/story-version/`（结构照抄 camera-derive/shot-review）

API 路径锁定：

1. `GET /api/generated-scripts/:id/story`
   - 已初始化：`{ initialized: true, storyVersion, storyDraft, versions: [{ version, savedAt, note }] }`（versions 倒序、不含全文、**包含当前版本**）；
   - 未初始化：`{ initialized: false, storyVersion: 0, storyDraft: <派生建议初稿>, versions: [] }`——初稿从现有数据派生：logline 取 `newTitle`；beats 从 `newNarrative.structure` 整段放入单个 beat（title "三幕结构"）+ `rhythm`、`climaxDesign` 各一个 beat；hooks 从 `newNarrative.climaxDesign` 提取形如 `MM:SS` 的时间点（正则），提不出则空数组。**派生初稿不落库**。
2. `PUT /api/generated-scripts/:id/story` body `{ storyDraft, note?, markShotsStale?: boolean }`
   - 校验（锁定）：`storyDraft` 必须是对象；`logline` 为字符串；`beats`/`hooks` 为数组，元素的
     `title`/`summary`/`time`/`label` 必须为字符串（元素 `id` 缺失则服务端补 UUID）；`note` 若提供
     必须为字符串且 ≤ 500 字符；违规 400 + code；
   - 落库：`storyVersion + 1`（首次保存 = v1），**新版本快照（含 note/savedAt）追加进 storyVersions**，
     `storyDraft` 更新为新内容镜像；storyVersions 超 10 裁最旧；
   - `markShotsStale === true` 时：所有**已有成功生成结果**的分镜 `isStale = true`。
     判定口径（锁定，本模块自行查询，不依赖 shot-review 内部函数）：
     `comfyui_tasks` 中 `projectId = :id AND targetType='shot' AND viewType='main' AND status='succeeded' AND imageUrl IS NOT NULL`，按 targetId 去重；
   - 返回 `{ success: true, storyVersion, staleMarked: <标记数> }`。
3. `GET /api/generated-scripts/:id/story/versions/:version` → 该历史版全文 `{ version, savedAt, note, storyDraft }`；404 带 code。
4. `POST /api/generated-scripts/:id/story/rollback` body `{ version, markShotsStale?: boolean }`
   - 把该历史版内容作为**新版本**保存（回滚也走版本递增，历史不可变），快照追加语义同 PUT；
   - 回滚目标 = 当前版本时返回 400 + code（无意义操作，前端也会禁用该项）。

**"基于故事 v几"收敛说明（裁决 2026-07-15）**：P2a 只落 `isStale`（"基于旧输入"布尔标注）；
分镜与具体故事版本号的数值绑定（`basedOnStoryVersion`）需要写入生成链路，超出本任务边界，
归 P3 生成参数快照一并实现。集成计划已同步修订。

错误处理与 WP-B 同风格：4xx + machine-readable `code`，不静默降级。写库走注册注入的 `mutateDb`（参照你 shot-review 的 deps 注入）。

## 三、前端组件（新建文件，自包含，禁碰 App.tsx/index.css/router.ts）

样式约定：跟随现有暗色工作台的 tailwind 风格（slate-900 系底、text-xs 层级、rounded-xl；参考 App.tsx 现有面板类名的视觉密度），不引入任何新依赖与全局样式。

### 1. `src/components/StoryEditor.tsx`

```ts
// 返回类型交给 TS 推断,不要显式写 JSX.Element(仓库未装 @types/react,显式全局 JSX 有类型风险)
export default function StoryEditor(props: {
  projectId: string;
  onSaved?: (info: { storyVersion: number; staleMarked: number }) => void;
})
```
- 挂载时 GET story，渲染三块可编辑区：
  ① 一句话故事（单行输入）；② beat 列表（title + summary，多行、可增删、可上下移）；③ 爽点时间轴（time + label，可增删）；
- 顶部显示"故事版本 v{n}"（未初始化显示"未保存的建议初稿"）；
- 保存按钮 + 勾选"将受影响分镜标记为『基于旧输入』"（默认勾选）+ 可选备注输入；保存后展示"已保存 v{n}，标记 {m} 镜"，并调 `onSaved`；
- 版本历史：下拉列出全部版本快照（v/时间/备注，含当前版），选择后可预览全文并「回滚为新版本」（需 confirm）；**当前版本可预览但禁用回滚按钮**；
- 所有请求失败态要有明确错误展示；保存中禁用按钮。

### 2. `src/components/ShotVersionPanel.tsx`

```ts
// 返回类型同样交给 TS 推断
export default function ShotVersionPanel(props: {
  projectId: string;
  shotId: string;
  finalTaskId?: string;
  onShotUpdated: (shot: any) => void;   // 定稿/取消定稿成功后回传服务端返回的 shot
})
```
- 挂载/props 变化时 GET `/shots/:shotId/versions`（WP-B API），网格展示各版本：缩略图（复用图片失败占位思路：空/加载失败显示文字块，不出破图）、seed、模型、时间、状态；
- 当前定稿版本高亮 + "已定稿"徽标；每个成功版本提供「设为定稿」（PUT final），当前定稿提供「取消定稿」（DELETE final）；操作后调 `onShotUpdated(result.shot)` 并刷新列表；
- 无版本时显示空态（"该分镜还没有生成记录"）；版本 >8 个时可滚动。

## 四、测试与验收

- 后端：`server/modules/story-version/*.test.ts`（node:test + assert/strict，`:memory:` SQLite + 隔离 fixture，参照你 shot-review 的测试基建）。至少覆盖：未初始化派生初稿（含 hooks 时间提取）、首次保存 v1 且 `GET /versions/1` 立即可用、版本递增与快照裁剪（>10）、markShotsStale 只标有成功结果的分镜（口径 SQL）、rollback 产生新版本、回滚当前版本 400、不存在版本 404、坏输入 400（含 note 超长）。
- 前端组件：`npm run lint` 通过即可（项目无前端测试框架）；组件的真机联调由 CC 接线后共同完成。
- 验收证据：`docs/ui-redesign/tasks/evidence/story-version-acceptance.md`（测试输出 + db 副本上的 curl 全流程：GET 未初始化 → PUT v1 → PUT v2+markStale → GET versions → rollback → 验证 isStale）。

## 五、边界（违反即返工）

- server.ts 只许 1 行 import + 注册区 1 行 register；
- 前端只许新建上述两个组件文件 + `src/types.ts` 的 GeneratedScriptRecord 追加字段；**App.tsx / index.css / router.ts / main.tsx 禁碰**；
- 不碰 `server/modules/shot-review|export-deck|camera-derive|shot-analysis`（引用其导出函数可以，修改不行）；
- 不建表、不加依赖、正式 db.sqlite 零污染；
- 提交前缀 `feat(story-version): ...`，不 push，完成后通知协调人（CC）review 与接线。
