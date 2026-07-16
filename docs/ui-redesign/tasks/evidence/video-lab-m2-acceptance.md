# Video Lab M2 验收证据

- 日期：2026-07-16
- 基线：`feature/camera-derive@f801086`
- 分支：`feat/video-lab-m2`
- 工作树：`C:\Users\Owner\Documents\GitHub\wt-video-lab-m2`
- 验收方式：Express 内存 fixture + stub `submitVideoTask` / `mutateDb` / 视频任务读取 / 本地文件可读检查
- 外部副作用：真实 Provider 调用 0；正式 `db.sqlite` 写入 0；正式 `uploads/` 写入 0

## 1. 交付范围

### 后端

- `GET /api/video-lab/shots/:shotId/tasks?projectId=`：先校验项目与镜头，返回完整 Take 历史并在模块内保证 `created_at DESC`。
- `PUT /api/video-lab/shots/:shotId/final-video?projectId=`：只允许同镜头、已完成、已本地落盘且文件可读的 Take 定稿；`taskId: null` 干净删除 `finalVideoTaskId`。
- `POST /api/video-lab/batch-shot-tasks`：服务端强制 `confirmed: true`；镜头去重且最多 100；整批预检通过后串行提交；单条失败不阻断后续任务；每镜头独立 seed 与 M1 快照。
- `VideoLabDeps` 已按 M2 契约加入四个必需回调；注册函数临时接受这些字段缺席，未由 `server.ts` 接线时返回显式 `503 VIDEO_LAB_M2_NOT_CONFIGURED`。这是为了遵守本包禁止修改 `server.ts` 的边界；CC 接线后路由启用。
- 模块不直接访问 SQLite，也不信任 `video_url`。

### 前端

- 选中镜头后加载历史 Take，显示 M1 状态文案、创建时间、seed、请求时长、下载错误。
- 最多选择 3 个 `completed + local_path` Take，以独立原生 `<video muted loop controls>` 并排对比；没有复用顺播语义的 AnimaticPlayer。
- 定稿成功显示金色徽标，可换选或取消；五个定稿拒绝码均有独立中文映射，`TAKE_NOT_DOWNLOADED` 会附 `download_error`。
- 批量选择默认勾选未定稿镜头，复用 Provider 能力参数；成本确认层分别显示镜头数量、任务数量、总输出秒数、预计运行秒数、Provider 与实际计费口径。
- 批量 409 复用 M1 画幅三选层；submitted / failed 明细均可跳到对应镜头 Take 列表。
- 未增加导出、打包、下载重试、Take 删除等 M3 入口。

## 2. 定稿 422 逐 code 复现

测试：`server/modules/video-lab/routes.test.ts` → `final-video rejects all five unsafe take states without mutating the project`

| 输入状态 | HTTP | code | 附加断言 |
| --- | ---: | --- | --- |
| taskId 不存在 | 422 | `TAKE_NOT_FOUND` | `mutateDb` 未调用 |
| task 属于另一个 shot | 422 | `TAKE_SHOT_MISMATCH` | `mutateDb` 未调用 |
| status = `in_progress` | 422 | `TAKE_NOT_COMPLETED` | `mutateDb` 未调用 |
| completed 但 `local_path = null` | 422 | `TAKE_NOT_DOWNLOADED` | 响应带 `download_error: "disk full"`；`mutateDb` 未调用 |
| completed 且有 local_path，但文件检查为 false | 422 | `TAKE_FILE_MISSING` | `mutateDb` 未调用 |

同组结束断言：项目 shot 不含 `finalVideoTaskId`。另一个测试证明可读本地 Take 成功写入，并且 PUT null 后使用 `delete` 移除字段。

## 3. 批量矩阵

| 场景 | 结果 |
| --- | --- |
| `confirmed` 为 false / 缺失 | 422 `BATCH_NOT_CONFIRMED`，`submitVideoTask` 0 调用 |
| 去重后超过 100 | 422 `BATCH_TOO_LARGE`，0 调用 |
| 选入项目外 shot | 404 `SHOTS_NOT_FOUND`，返回 `missingShotIds`，0 调用 |
| `optimizedPrompt` 与 `description` 都为空 | 422 `SHOTS_MISSING_PROMPT`，返回缺失列表，0 调用 |
| 项目画幅不受支持且无 decision | 409 `ASPECT_UNSUPPORTED`，0 调用 |
| 两镜中第一条 provider 创建失败 | 第二条继续；HTTP 201；submitted / failed 明细均正确 |
| 重复 shotId | 去重后只提交一次 |
| 两镜快照 | seed 不同，且每条快照 seed 与提交 seed 一致 |
| 全部 provider 创建失败 | 所有条目仍被依次调用，HTTP 502，failed 明细完整 |

## 4. 实际验证结果

### M2 / M1 Video Lab 路由测试

命令：

```powershell
npx tsx --test server/modules/video-lab/routes.test.ts
```

结果：`17 tests / 17 pass / 0 fail`。

### 全模块测试

命令：

```powershell
$tests = rg --files server/modules -g '*.test.ts'
npx tsx --test $tests
```

结果：`54 tests / 54 pass / 0 fail`，即基线 46 + M2 新增 8。

### 静态检查与构建

```powershell
npm run lint
npm run build
```

- lint：PASS（`tsc --noEmit`，退出码 0）
- build：PASS（Vite 2091 modules transformed，退出码 0）
- build 仅有既存的 chunk > 500 kB 提示，无错误

### 边界检查

- `git diff --check`：PASS
- 改动仅落在任务书允许的 6 个目标：`server/modules/video-lab/**`、`src/components/VideoLabPanel.tsx`、`src/types.ts` 单行、本文档。
- 主工作区仍为 `feature/camera-derive@88f0ece`，用户原有 `src/index.css` 修改保持原样。

## 5. CC 接线与真机待验

以下属于任务书明确分给 CC 的后续工作，本提交不越界执行：

1. 在 `server.ts` 注入 `mutateDb`、`listVideoTasksByShot`、`getVideoTask`、`isLocalVideoReadable`。
2. 用真实 Agnes 批量生成 2 镜：成本确认 → Take 列表 → 三路以内并排预览 → 定稿 → 核对 JSON 指针与任务快照。
3. 核对定稿实物时，输出尺寸只信 ffprobe/实物，不信 provider `normalized_size`。实际时长回填 `normalized_seconds` 已按任务书顺延 M3，本面板当前显示 M1 请求快照时长。

真 Agnes 与接线后浏览器链路：**UNVERIFIED（按分工留给 CC）**。

---

## 6. CC 接线与真机验证增补（2026-07-16，CC 执行）

### 6.1 接线

- 合并 `feat/video-lab-m2` → `feature/camera-derive`（干净合并，用户 `src/index.css` 未提交改动保持原样）。
- `server.ts` 注入四个 deps：
  - `mutateDb`：复用既有写队列版本；
  - `listVideoTasksByShot`：`SELECT * FROM video_tasks WHERE shot_id = ? ORDER BY created_at DESC`；
  - `getVideoTask`：复用既有 `videoTaskRow`；
  - `isLocalVideoReadable`：复用 export-deck `naming.ts` 的 `getLocalPath`（含路径穿越防护）+ `isReadableFile`，语义与 getLocalPath 完全同源（直接 import，非复制）。
- 接线后：`npm run lint` PASS；全模块测试 **54/54 PASS**（含 Video Lab 17/17）。

### 6.2 真机全链路（真实 Agnes，项目 1783192733645《孤岛豪宅谋杀案》）

1. **成本闸门（硬规则 C）**：选 2 镜 → 确认层三数字分开显示：镜头数量 2 / 预计生成任务 2 / 总输出时长 6 秒（精确）/ 估算运行时间 140 秒（2×70）/ Provider Agnes Video v2.0 / 费用=Provider 实际计费。
2. **409 画幅层**：项目 1:1 vs Agnes 3:2 → 三选层（更换模型置灰/裁切/留边）→ 选裁切后重提成功，快照 `aspect.adaptMode="crop"`、`source="user_adaptation"`。
3. **部分失败真机复现**：Agnes 实际限流「1 请求/分钟」，串行第二镜被拒 → HTTP 201，UI 明细「已提交 1（shotId→taskId）/ 提交失败 1（附完整限流错误）」，failed 任务行保留审计（fc2113ca）。第一镜不受影响完成。1 分钟后单选 #2 重批（再次走成本闸门+画幅层）成功。
4. **Take 列表**：#1 两条 completed Take（M1 的 af994104 + 批量的 6a6ed127，倒序、seed/时间/时长齐全）；#2 列表含失败 Take（红标限流错误、无定稿按钮）+ completed Take（0eccb50d）。
5. **并排对比**：#1 勾选 2 个已落盘 Take → 两个独立原生 `<video muted loop controls>` 并排，src 分别指向两条 local_path，无 AnimaticPlayer 复用。
6. **定稿**：#1 定稿 6a6ed127、#2 定稿 0eccb50d → ★ 当前定稿徽标 + 「取消当前定稿」按钮出现，另一 Take 保留「设为定稿」可换选；批量镜头列表同步显示「#1 ★ 已定稿」且默认勾选数 74→73（排除已定稿）。
7. **落库核验**（store JSON + video_tasks 直查）：
   - `shot#1 6d0bdf3a → finalVideoTaskId 6a6ed127`；`shot#2 a9b34783 → finalVideoTaskId 0eccb50d`；
   - 两条任务快照 seed 与行 seed 逐一一致且互不相同（8234022103841080 / 6959500733383248）；
   - local_path 文件均存在可读（453789 / 116673 字节）。
8. **备忘①复验（实物 ffprobe）**：两条定稿视频实际均为 **1088x832 @ 24fps、81 帧、3.375s**，provider `normalized_size=1152x768` 再次与实物不符——输出尺寸只信 ffprobe/实物的裁决在 M2 继续成立。`normalized_seconds=3.4` 亦为 provider 口径（实测 3.375）。

### 6.3 真机新发现（与 M2 代码无关，已另行立项/记录）

- **前端失控轮询**：App 对 `/api/generated-scripts`、`/api/comfyui/tasks` 高频轮询，几分钟 1.4 万+ 请求触发 `net::ERR_INSUFFICIENT_RESOURCES`，页面 fetch/媒体加载被饿死（Video Lab 面板首次打开卡「正在加载」、并排视频 readyState 停 0 均由此引起；服务端对同 URL HEAD 200 正常）。已开独立修复任务。
- **Agnes 限流 1 req/min**：批量串行提交 >1 镜必然部分失败，M2 行为正确（失败保留审计、不阻断），但 M3 可考虑批内节流/重试间隔。

结论：M2 真机链路 **PASS**（浏览器视频渲染受上述既有轮询 bug 干扰，服务侧与数据侧证据完整）。
