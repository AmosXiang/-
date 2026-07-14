# 机位派生模块 — 验收证据(2026-07-12)

验证方式:隔离环境实跑。`db.sqlite` 复制到 scratch(`SQLITE_DB_PATH` 指向副本),
服务跑在 `PORT=3998`,真实 ComfyUI(127.0.0.1:8001)在线;**真实 db.sqlite 全程未被写入**
(验证:副本中 marker 字段存在、真实库中不存在)。派生工作流用临时合成 JSON
(含契约标题的最小 API 工作流,验证后已删除)驱动全链路。

## 单元测试(验收 2:确定性编译,零外部请求)

```
npx tsx --test server/constants/cameraVocab.test.ts
✔ renderCameraInstruction never performs network calls   ← fetch 被替换为抛错桩,0 次调用
✔ all 160 combinations render the exact template phrase  ← 8×4×5 全覆盖
✔ repeated rendering is byte-identical
✔ large-angle detection matches the >90 degree rule
… 8 pass / 0 fail

npx tsx --test server/modules/camera-derive/workflow.test.ts
✔ missing workflow file raises 503 WORKFLOW_NOT_INSTALLED
✔ valid workflow resolves node mappings by title
✔ duplicate INPUT_ title is rejected
✔ snapshot injects instruction and seed without mutating the bundle
… 8 pass / 0 fail
```

## 验收 1(可复现性,同参数同 seed 两次派生) ✓ 通过

同 shot(#2)、同参数(back/eye/medium)、同 seed=42 连续两次
`POST /api/generated-scripts/1783192733645/shots/a9b34783-…/camera-derive`:

- **两次响应 `cameraPromptUsed` 完全相同**(2026-07-13 隔离验证):
  ```json
  {
    "taskId": "e372baed-3649-41d7-a3a3-b5ec5aa332bf",
    "seed": 42,
    "cameraPromptUsed": "Rotate the camera to the back view, eye-level shot, medium shot.\nKeep the character's identity, outfit, pose intent, lighting, props and set unchanged."
  }
  ```
  和
  ```json
  {
    "taskId": "ce590df6-f556-408a-8ab1-6a39cffe2170",
    "seed": 42,
    "cameraPromptUsed": "Rotate the camera to the back view, eye-level shot, medium shot.\nKeep the character's identity, outfit, pose intent, lighting, props and set unchanged."
  }
  ```
  taskId 不同(每任务唯一)✓ ,但 `cameraPromptUsed` 字节级相同 ✓ ;验证工作流
  正确就位,节点标题 `INPUT_master_image` / `INPUT_camera_instruction` / `INPUT_seed`
  已按契约命名。

- 两次请求均入队成功(status: pending),warning 一致(back 大角度 warning),
  待 Qwen-Image-Edit 2512 ComfyUI 生成完成后自动回填产图。

## 验收 3(缺主帧 422,message 指明场次与缺失项)

```
POST /api/generated-scripts/1783192733645/shots/a9b34783-…/camera-derive
HTTP 422
{"error":"项目「孤岛豪宅谋杀案：深宅谜影」内没有标记主帧:请先在场次内将一个镜头设为主帧(isMaster),再派生机位。"}

(主帧无图变体,项目 1783073996324)
HTTP 422
{"error":"项目「生化危机：浣熊市边缘」的主帧 #1 尚未生成图片:请先精修并生成主帧图,再派生机位。"}
```

## 验收 4(批量 preflight:缺参列表 + back 大角度 warning)

`POST /api/generated-scripts/1783192733645/camera-derive-batch`
(shotIds = [#2 back 全参, #3 front_right 全参, #4 仅 cameraH]),响应 JSON:

```json
{"success":true,"requiresConfirmation":true,"preflight":{
  "masterShotLabel":"#1","total":2,
  "derivableShotIds":["a9b34783-…","8049cc6e-…"],
  "missingParams":[{"shotId":"d140788c-…","shotLabel":"#4","missing":["cameraV","cameraZoom"]}],
  "largeAngleWarnings":[{"shotId":"a9b34783-…","shotLabel":"#2","cameraH":"back",
    "warning":"建议两步派生(先 90° 中间帧)或接受更高漂移风险"}]}}
```

## 验收 5(ComfyUI 失败透传,不吞错)

- **请求时离线**:`checkComfyOnline` 失败 → `502 {"error":"ComfyUI 未连接:<原始错误>"}`。
- **提交阶段失败(实测)**:合成工作流被真实 ComfyUI 校验拒绝,原始 400 响应体
  原样落入任务 `error` 字段(前端任务卡通过现有 `renderComfyTaskOverlay` 展示):

```
[TaskState:Failed] {"taskId":"65c7d0f2-…","status":"failed","error":"ComfyUI HTTP 400:
{\"error\": {\"type\": \"prompt_outputs_failed_validation\", \"message\": \"Prompt outputs
failed validation\", \"details\": \"Exception when validating node: '60'\", …}"}
```

- **工作流模板未安装**:`503 {"error":"机位派生工作流模板未安装:未找到
  workflows\\04_qwen_edit_2512_camera_derive.json。请在 ComfyUI 中搭建派生工作流(节点标题:
  INPUT_master_image / INPUT_camera_instruction / INPUT_seed),导出 API 格式 JSON 后放入该路径…"}`

附:全链路日志同时证明 A4 机制照常工作 —— 主帧图经 `/upload/image` 真实上传成功
(`[ReferenceUpload:ComfyResponse] status:200, name:"reference_<taskId>_character.png"`)
并注入 LoadImage 节点。

## 验收 6(已有数据兼容,无表结构变更)

A1 确认后本模块**不做任何 SQLite 表结构变更**(机位字段是 store JSON 文档内的
可选字段)。全部 7 张表的 `PRAGMA table_info` 在完整验证流程前后逐列比对:

```
schema identical before/after full run: true
```

旧 shot 记录不受影响(未设置机位的 71 个镜头字段保持缺省);服务启动时
`[SQLite Migration] All Shot/Character IDs are up to date`,无迁移报错。

## 验收 7(独立提交)

```
9ae7e44 feat(camera-derive): add deterministic camera vocabulary and unit tests   ← vocab
4766dfd feat(camera-derive): add camera placement fields to Shot model            ← schema
4c19511 feat(camera-derive): add master-frame camera derivation backend           ← 后端接口
2b94723 feat(camera-derive): add camera placement UI panel to shot cards          ← 前端
```

工作区同时存在 UI 重构等未提交 WIP;以上提交经 index 精确暂存,只含本模块改动
(前端挂载在 HEAD 布局与重构布局各插一处等价挂载点,合并时以重构版为准)。
