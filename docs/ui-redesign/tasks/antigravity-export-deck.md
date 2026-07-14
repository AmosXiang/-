# 任务书（Antigravity）：分镜交付包导出后端 API（WP-C）

> 直接把本文件全文作为任务粘贴给 Antigravity 即可。上下文自包含。
> 所属方案：`docs/ui-redesign/workflow-redesign-2026-07-14.md` §五；共享契约与禁改清单：`docs/ui-redesign/tasks/README.md`（以其为准，冲突时契约文件优先）。

## 背景

本项目是本地导演工作台（React 19 + Vite 前端，Express `server.ts` 后端，better-sqlite3）。创意项目（generatedScript）包含标题、叙事（structure/rhythm/climaxDesign）、角色表（含头像/三视图 URL）、分镜数组（时间码、时长、描述、运镜 camera{move,speed,note}、景别 framing{shotSize,angle}、走位 blocking、机位 cameraH/cameraV/cameraZoom、派生来源 derivedFromShotId、英文提示词 optimizedPrompt、图片 URL 等，字段定义见 `src/types.ts`）。分镜生成模块的终点产物是**「分镜交付包」**：一份 PPT 式分镜手册 + 机器可读 manifest + 定稿图目录，供人评审、供未来的视频生成模块作输入。你的任务是**纯后端**实现（前端由另一 agent 后续对接，你不要写任何前端代码）。

## 数据模型事实

- 分镜存于 SQLite `store` 键值表 `key='generated_scripts'` 的 JSON 文档：`generated_scripts[].newShots[]`。**没有 shots 表，禁止建表。**
- "定稿"由并行工作包（shot-review）提供，你**只读**这三个 Shot 可选字段：`finalTaskId` / `finalizedImageUrl` / `isStale`。旧数据可能全部缺失——必须优雅处理。
- 图片文件在 `uploads/projects/<projectId>/` 下，shot 上的 URL 形如 `/uploads/...`，对应本地文件。

### 字段映射表（锁定，按此读取，不得凭泛称猜字段名；定义见 `src/types.ts` GeneratedScriptRecord）

| 手册内容 | 实际字段 |
| --- | --- |
| 项目标题 | `newTitle` |
| 题材/主题 | `topic`（另有 `templateTitle` = 模板来源，可注封面小字） |
| 叙事三要素 | `newNarrative.structure` / `newNarrative.rhythm` / `newNarrative.climaxDesign` |
| 角色表 | `newCharacters[]`：`name`、`role`、头像取 `avatarImageUrl \|\| avatarUrl \|\| avatarGeneration?.imageUrl` |
| 分镜数组 | `newShots[]`：`timestamp`、`durationSec`、`description`、`optimizedPrompt`、`camera`、`framing`、`cameraH/V/Zoom`、`derivedFromShotId`、`isMaster`、`finalTaskId`、`finalizedImageUrl`、`isStale`、降级图 `generatedImageUrl \|\| imageUrl` |

### 图片资源有效性规则（锁定；"有 URL"≠"有可导出的图片"）

1. **只允许解析 `/uploads/...` 本地资源**；解析出的绝对路径必须仍位于 UPLOADS_DIR 内（防路径穿越），否则视为无效。
2. 远程 URL、`/api/pollinations-proxy?...` 等一律视为 `image_not_local`：**禁止联网下载**，审阅稿中按占位页处理。
3. "有效定稿" = `finalTaskId` 与 `finalizedImageUrl` 同时存在，**且**对应本地文件真实存在（`fs.existsSync`）。
4. 角色头像遵循同样规则（无效则封面用文字占位，不放破图）。
- 模块化后端标准姿势：照抄 `server/modules/camera-derive/` 的结构（index.ts 导出 register 函数 + routes.ts + 纯逻辑文件 + 同目录 `*.test.ts`），注册点在 `server.ts` 底部 L7407 附近。

## 交付物

新模块 `server/modules/export-deck/`，实现两个 API（路径已锁定，不得更改）：

### 1. `GET /api/generated-scripts/:id/delivery-check` — 交付前检查

返回：
```json
{
  "total": 17,
  "finalized": 12,
  "notFinalized": 5,
  "missingImage": 3,
  "failed": 0,
  "missingParams": 2,
  "stale": 1,
  "details": [{ "shotId": "...", "index": 4, "issues": ["missing_image", "missing_camera"] }]
}
```
统计口径（锁定）：
- `finalized`：**有效定稿**数（按上文图片有效性规则第 3 条，含本地文件存在校验）；
- `notFinalized`：无有效定稿版本的镜头数（= total − finalized）；
- `missingImage`：没有任何**可读取的本地**图片（定稿图与降级图都无效或缺失）；
- `failed`：该镜头最新一个主图生成任务状态为失败（从 comfyui_tasks 判定）；**不覆盖已有定稿**——已定稿镜头即使新任务失败也计入 finalized；
- `missingParams`：`camera`（含 move/speed 内部字段）或 `framing`（含 shotSize/angle）缺失，或 `durationSec` 不存在/不大于 0；
- `stale`：`isStale === true` 的镜头数。**语义：警告而非阻塞**——正式导出允许 stale，但 PPTX 页面须醒目标注且封面汇总"N 镜基于旧输入"；
- `details[].issues` 使用固定 issue code：`not_finalized` / `missing_image` / `image_not_local` / `missing_camera` / `missing_framing` / `missing_duration` / `stale_input` / `latest_task_failed`；
- 纯读，不写库。`export-deck` 的 409 响应复用同一 details 结构，前端凭 code 精确提示"为什么不能导出"。

### 2. `POST /api/generated-scripts/:id/export-deck` — 生成交付包

- 请求体：`{ mode: 'final' | 'review' }`（**双模式，不允许静默漏镜头**）：
  - `mode: 'final'` 正式交付包：仅当**全部**分镜为有效定稿（图片有效性规则第 3 条）才执行；
    否则返回 409 + `{ error, missing: [{ shotId, index, issues }] }`（issues 用上文 issue code），**不生成任何文件**；
    `stale` 不阻塞 final，但须按上文规则标注；
  - `mode: 'review'` 审阅稿：随时可用，保留完整镜头顺序；未定稿镜头降级用最新**本地**生成图、
    无有效本地图则生成占位页，两者页面都加醒目 `DRAFT` 标注；封面注明"审阅稿 · 已定稿 x/N"。
- 产物写入 `uploads/exports/<projectId>/<文件系统安全时间戳>/`——**Windows 目录名禁止冒号**，
  时间戳格式锁定为 `toISOString()` 后把 `:` 与 `.` 替换为 `-`（例 `2026-07-14T20-30-15-123Z`）：
  1. **`storyboard-deck.pptx`** —
     封面页：项目标题、题材/主题、叙事三要素摘要、角色表（头像缩略 + 名字 + 一句话角色定位）；
     每分镜一页：定稿图（占页面主体，无图时画占位框注明"未生成"）、页眉 `#序号 时间码 (时长s)`、结构参数块（运镜 move/speed/note、景别 shotSize、视角 angle、机位 cameraH/V/zoom、若 `derivedFromShotId` 存在则标注"派生自 #主帧序号"）、情节描述、视频生成参考（`optimizedPrompt` 原文）。中文正文 + 参数值保留英文枚举原样。若分镜 `isStale === true`，页脚标注"⚠ 基于旧版剧本生成"。
  2. **`storyboard-manifest.json`** — 同构机器可读清单：
     ```json
     {
       "manifestVersion": 1,
       "projectId": "...", "title": "...", "exportedAt": "ISO8601",
       "narrative": { "structure": "...", "rhythm": "...", "climaxDesign": "..." },
       "characters": [{ "id": "...", "name": "...", "role": "...", "avatarUrl": "..." }],
       "shots": [{
         "id": "...", "index": 1, "timestamp": "00:00 - 00:07", "durationSec": 5,
         "description": "...", "optimizedPrompt": "...",
         "camera": {"move":"static","speed":"medium","note":""},
         "framing": {"shotSize":"medium","angle":"front"},
         "cameraH": null, "cameraV": null, "cameraZoom": null,
         "derivedFromShotId": null, "isMaster": false,
         "finalized": true, "isStale": false,
         "imageFile": "finals/shot-01.png"
       }]
     }
     ```
  3. **`finals/`** — 每镜一张图的文件拷贝，命名 `shot-<两位序号>.<原扩展名>`。
- 选图规则：`final` 模式只用有效定稿图；`review` 模式定稿图优先，无定稿降级最新**有效本地**生成图（manifest 中该镜标 `finalized:false`），无图/非本地则 `imageFile:null` + PPTX 占位页。
- manifest 顶层增加 `"mode": "final" | "review"`。
- 响应（**files 一律是浏览器可下载的 URL 路径，不是 Windows 文件路径**；本机路径单独放 `exportDir`）：
  ```json
  {
    "success": true, "mode": "final",
    "exportDir": "C:\\...\\uploads\\exports\\<id>\\<ts>",
    "files": {
      "pptxUrl": "/uploads/exports/<id>/<ts>/storyboard-deck.pptx",
      "manifestUrl": "/uploads/exports/<id>/<ts>/storyboard-manifest.json",
      "zipUrl": "/uploads/exports/<id>/<ts>/storyboard-delivery.zip"
    },
    "summary": { "...": "同 delivery-check 结构" }
  }
  ```
- 另将三产物打一个 zip（`storyboard-delivery.zip`）放同目录，方便一键下载。

### PPTX 版式与溢出策略（锁定）

- 页面 16:9；分镜图**保持比例（contain），不拉伸**，图外留白用深色底；
- 中文字体统一 `Microsoft YaHei`（微软雅黑，Windows 必装），参数值/枚举保留英文原样；
- **每镜一页是硬性约束，不续页**：描述与 `optimizedPrompt` 各占固定文本区，超长截断并以
  `…（全文见 manifest）` 结尾；manifest 永远保留全文——页面是摘要，manifest 是真相源；
- DRAFT 标注用角标 + 文字（不只靠颜色）；`stale` 镜头页脚"⚠ 基于旧版剧本生成"。

### 3. 依赖

允许新增 npm 依赖：`pptxgenjs`（生成 PPTX）与 `jszip`（打 zip）。不得引入其他依赖；不得调用任何外部网络服务（纯本地生成）。

### 4. 测试

`server/modules/export-deck/*.test.ts`，Node 内置 `node:test` + `assert/strict`（风格照抄 `server/modules/camera-derive/workflow.test.ts`）。至少覆盖：delivery-check 各计数口径（含旧数据无新字段）、`final` 模式未全定稿时 409 且零产物、`review` 模式完整顺序 + DRAFT 标注、选图规则（定稿优先/降级/占位）、manifest 结构完整性、文件命名。PPTX 内容可用 jszip 解包断言 slide 数量与关键文本。

### 5. 验收证据（视觉验收不是可选项）

`docs/ui-redesign/tasks/evidence/export-deck-acceptance.md`：测试输出 + 对一个真实项目导出的 curl 演示 + 产物目录树。
**必须包含渲染检查**：实际打开生成的 PPTX，核查五类页面——封面、正常镜头页、DRAFT 镜头页、
无图占位页、长文本镜头页（文字不溢出、图片不拉伸、中文不乱码），附截图。
jszip 解包断言只能证明结构存在，不算视觉验收。若环境确实无法渲染 PPTX，
验收结论必须标记 `PARTIAL` 并写明未验证项，**不得报完整 PASS**。

## 边界（违反即返工）

- `server.ts` 只允许：顶部 1 行 import + L7407 注册区 1 行 register 调用。
- **不碰任何 `src/**` 文件**（包括 types.ts——`finalTaskId` 等字段由并行工作包定义，你只读）。
- 不碰 `server/modules/shot-review/`（另一 agent 的并行工作区）、不碰既有端点、不建表、不删改 `uploads/` 既有文件（只新增 `uploads/exports/`）。
- `package.json` 只加上述两个依赖，**`package-lock.json` 随之同步提交**（否则安装不可复现）。
- 分支 `feat/export-deck-api`，基线 commit 以协调人（Claude Code）通知为准；提交信息用 `feat(export-deck): ...` 前缀。
