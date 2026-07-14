# ComfyUI 新工作流导入规范

本规范用于候选预设的离线准备和评审。候选必须先进入隔离目录，不能直接覆盖或替换现有生产预设。

## 1. 必需文件

每个候选工作流使用独立目录，并同时包含：

```text
candidate_preset_id/
  manifest.json
  api.json
  ui.json
```

- `manifest.json`：来源pin、用途、依赖、参数映射、参考图映射、输出映射及默认值。
- `api.json`：从目标版本ComfyUI使用 **Save (API Format)** 导出的真实API workflow。禁止用UI workflow、PNG元数据或空对象冒充。
- `ui.json`：能够在目标版本ComfyUI中重新打开的UI workflow，用于人工维护和重新导出API格式。

三个文件必须来自同一个上游commit和同一次映射审计。

## 2. Manifest 必需字段

```json
{
  "presetId": "candidate_id",
  "name": "Human readable name",
  "status": "evaluation-only",
  "source": {
    "repoUrl": "https://github.com/OWNER/REPO",
    "commit": "40-character-full-sha",
    "artifactPath": "path/in/repo/workflow.json"
  },
  "targetTypes": ["shot"],
  "viewTypes": ["main"],
  "requiredNodeClasses": [],
  "requiredModels": [],
  "parameterMappings": {},
  "referenceImageMappings": [],
  "outputMappings": [],
  "defaultParameters": {}
}
```

`commit` 必须是40字符完整SHA，禁止使用 `main`、`master`、tag或 `latest` 代替。

## 3. requiredNodeClasses

- 列出 `api.json` 实际引用的全部 `class_type`，包括ComfyUI原生节点和custom nodes。
- custom node同时记录仓库URL、完整commit SHA和许可证。
- 导入检查只能读取 `/object_info` 或等价的节点清单；不得自动安装缺失节点。
- 任一节点缺失时，候选状态保持 `evaluation-only`，不得进入生产预设列表。

## 4. requiredModels

每个模型至少记录：

```json
{
  "filename": "model.safetensors",
  "category": "diffusion_models",
  "sourceUrl": "https://.../resolve/FIXED_REVISION/model.safetensors",
  "revision": "fixed-revision-or-sha",
  "sizeBytes": 0,
  "sha256": "64-character-sha256",
  "required": true
}
```

- 模型URL必须固定revision；禁止使用指向可变 `main/latest` 的生产下载地址。
- 大小和SHA256未知时可提交评估，但不得标记为 `validated`。
- 导入器只评估文件是否存在和哈希是否匹配，不自动下载模型。

## 5. prompt / seed / size / output 映射

统一格式：

```json
{
  "parameterMappings": {
    "prompt": { "nodeId": "76", "inputKey": "text", "required": true },
    "negativePrompt": null,
    "seed": { "nodeId": "75:73", "inputKey": "noise_seed", "required": true },
    "width": { "nodeId": "75:68", "inputKey": "value", "required": true },
    "height": { "nodeId": "75:69", "inputKey": "value", "required": true }
  },
  "outputMappings": [
    { "nodeId": "9", "classType": "SaveImage", "outputType": "IMAGE" }
  ]
}
```

- node ID和input key必须同时存在于 `api.json`。
- 不适用的映射明确写 `null`，并在manifest备注原因。
- seed必须保留64位安全语义；不得经过JavaScript `Number` 产生精度丢失。
- 至少存在一个可追踪的输出节点。

## 6. Reference image 映射

没有参考图时使用空数组。有参考图时，每个输入必须声明：

```json
{
  "referenceImageMappings": [
    {
      "role": "characterIdentity",
      "nodeId": "76",
      "inputKey": "image",
      "uploadMode": "comfy-input-filename",
      "required": true
    }
  ]
}
```

- 上传后的ComfyUI文件名只能注入manifest声明的 `LoadImage` 类节点。
- PuLID必须额外映射strength；IPAdapter必须映射weight、weight type和start/end。
- reference缺失时应返回结构化预检错误，不得静默退化到不同工作流。

## 7. 状态和验收门槛

候选状态只允许：

1. `evaluation-only`：文件已归档，但依赖/映射未完全验证。
2. `mapped`：三件套一致，全部节点、模型和输入输出映射已静态检查。
3. `validated`：在目标ComfyUI和RTX 5070上完成固定seed API dry-run、单张真实生成、输出回写及显存峰值记录。

候选目录禁止标记为 `production`。进入生产区必须单独评审，并分配新的预设ID；不得覆盖 `01/02/03/04`。

## 8. 导入检查顺序

1. 校验目录和三件套文件存在。
2. 校验完整commit SHA和上游artifact路径。
3. 对比 `api.json` 与 `requiredNodeClasses`。
4. 检查 `requiredModels` 的文件、大小和SHA256。
5. 验证prompt、seed、width、height、output映射。
6. 验证reference image映射及其节点类型。
7. 加载 `ui.json` 人工审计，再从同一环境重新导出 `api.json` 对比。
8. 单候选、batch=1执行验收；第一阶段不运行该步骤。

