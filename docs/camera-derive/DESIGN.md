# 机位派生模块(Camera Derive)— 设计与假设确认

> 对应任务书:主帧 → 多机位派生(Qwen-Image-Edit 2512)。
> 本文档记录 §9 假设 A1–A5 的读码确认结果,以及由此产生的方案调整。

## A1–A5 假设确认结果

### A1:shots 表实际表名/主键/scene 外键 — **假设不成立,方案调整**

代码事实(server.ts `readDb`/`writeDb`,约 L673–L787):

- **不存在 `shots` SQLite 表**。分镜存于 `store` 键值表(`key='generated_scripts'`)的 JSON
  文档内:`generated_scripts[].newShots[]`,shot 主键为字符串 UUID `id`。
- **不存在 scene 实体**——shots 是项目(generatedScript)下的平铺数组,无场次分组字段。
- Shot 上已有 `camera`/`framing` 等结构化 JSON 字段先例(storyboard enrichment)。

调整:

1. §3 的 `ALTER TABLE shots ADD COLUMN ...` 改为 Shot JSON 可选字段:
   `cameraH` / `cameraV` / `cameraZoom` / `isMaster` / `derivedFromShotId` / `cameraPromptUsed`
   (`src/types.ts`)。旧记录无字段即未设置,天然向后兼容,**无需迁移脚本**;
   验收 6 的 `PRAGMA table_info` 证据退化为"无任何表结构变更"。
2. "场次(scene)"按**项目粒度**落地:主帧 = 项目内 `isMaster === true` 的唯一镜头
   (应用层在设置时清除其他镜头的标记);批量派生接口挂在项目路径下。
   若后续引入真正的场次分组,只需给 Shot 增加 `sceneKey` 并把主帧唯一性校验的
   分组维度从项目改为 sceneKey,词表与派生流程不受影响。
3. 审计字段 `camera_prompt_used` → `cameraPromptUsed`(shot JSON)+ comfyui_tasks 行的
   `prompt` 列与 `presetParametersJson.cameraDerive`(双写,任务行含完整快照)。

### A2:现有 ComfyUI 参数注入按节点 title 还是 node id — **manifest 声明的 node id**

代码事实:预设工作流(`workflows/character/*.manifest.json`)通过 `nodeMappings`/
`parameterNodeIds` 声明 node id,任务创建时注入 prompt/seed 生成 `apiWorkflowJson`
快照(`prepareComfyTaskData`);worker 提交前仅注入参考图文件名
(`submitComfyTask`,经 `/upload/image`)。title 正则定位只存在于 legacy 自定义
工作流路径(`findComfyNode`)。

调整:派生工作流 JSON 由 Amos 手工导出,node id 导出前未知,manifest 无法预先
提交。故按任务书 §5 的 title 契约实现:`loadCameraDeriveWorkflow()` 在加载时按
`_meta.title`(`INPUT_master_image` / `INPUT_camera_instruction` / `INPUT_seed`)
**确定性解析**为 node id,解析结果随任务行存储
(`presetParametersJson.cameraDerive.nodeMappings`),worker 据此注入主帧图片。
标题缺失/重复/类型不符一律报错,不静默降级。该预设无 manifest,
`exportedUiWorkflow` 对其原样导出 API 快照。

### A3:批量 preflight 接口形态 — **同接口两态(confirmed 标志),非独立 dryRun 接口**

代码事实:`/api/generate-image` 批量分支(server.ts ~L6150–L6180):
`confirmed !== true` 时返回 `{ success, requiresConfirmation: true, preflight }`,
前端确认后带 `confirmed: true` 重发执行。

对齐:`POST /api/generated-scripts/:id/camera-derive-batch` 采用同一模式。

### A4:图片进入 ComfyUI input 目录机制 — **`POST /upload/image` multipart 上传**

代码事实:worker 在提交前读取 `task.sourceImageUrl`(`/uploads/...`),经
`resolveReferenceImageFile` 解析本地文件,multipart(`type=input`,
`overwrite=true`)POST 到 ComfyUI `/upload/image`,返回文件名注入
`loadImageNodeId`。

对齐:派生任务把主帧图 URL 写入 `sourceImageUrl`,**完全复用**该机制与既有轮询
(`pollActiveTasks`)、落盘(`persistComfyImage`)、写回 shot(`generatedImageUrl`)
路径,零新增轮询代码。

### A5:模块拆分约定 — **存在,`server/modules/<name>/` + register 函数**

代码事实:`server/modules/shot-analysis/` 经
`registerShotAnalysisModule(app, dbSqlite)` 注册。

对齐:新代码位于 `server/modules/camera-derive/`(routes.ts / workflow.ts /
index.ts),`registerCameraDeriveModule(app, dbSqlite, deps)` 注册;
`deps.mutateDb` 复用 server.ts 的串行写队列(store 文档写入必须串行),
`deps.checkComfyOnline` 复用 `comfyFetch`。词表按任务书路径放
`server/constants/cameraVocab.ts`。

## 接口(实际落地)

| 任务书 | 实际路径 | 说明 |
|---|---|---|
| `POST /api/shots/:shotId/camera-derive` | `POST /api/generated-scripts/:id/shots/:shotId/camera-derive` | 仓库无全局 shot 路由,一律带项目上下文 |
| `POST /api/scenes/:sceneId/camera-derive-batch` | `POST /api/generated-scripts/:id/camera-derive-batch` | scene 按项目粒度(A1) |
| —— | `PUT /api/generated-scripts/:id/shots/:shotId/camera` | 三下拉框落库 |
| —— | `PUT /api/generated-scripts/:id/shots/:shotId/master` | 主帧单选标记 |

错误语义:主帧缺失/无图/参数非法 → 422(message 指明项目与缺失项);
ComfyUI 离线 → 502 透传错误文本(请求时);工作流模板未安装 → 503;
worker 阶段的 ComfyUI 失败 → 任务 `error` 字段透传原始文本(现有任务卡 UI 展示)。

## 确定性保证

- 机位短语:`server/constants/cameraVocab.ts` 查表 + 单模板插值,零 LLM;
  单元测试覆盖 8×4×5 全组合与字节级复现(`cameraVocab.test.ts`)。
- 派生任务快照在创建时注入指令与 seed(`apiWorkflowJson`),同参数同 seed 重跑
  的指令与快照字节级一致;`cameraPromptUsed` 写回 shot 供审计。
- 大角度规则:目标 H 与主帧(front)差 >90°(back / back_left / back_right)时
  preflight 输出 warning,本期不自动两步派生。

## 环境依赖(Amos,任务书 §8)

`workflows/04_qwen_edit_2512_camera_derive.json`(API 导出,节点标题按 §5 契约)
就位前:派生接口返回 503 + 安装指引;词表/落库/preflight 均可用。
