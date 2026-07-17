# Agnes referenceImages A/B 调研结论（P1 前置门 · CC 真机）

日期：2026-07-17
执行：CC，真实 Agnes（免费，零计费顾虑，用户确认）
分支：`feature/camera-derive`（P0 已合入）

## 结论（决定性）

**Agnes `referenceImages` 不是风格参考，而是主体/构图参考（image-to-image / omni 语义）。不能用作项目风格锚图通道。**

因此 **P1-B 注入方案定向：风格锚图只走 ComfyUI 侧 IPAdapter；Agnes 保持纯 prompt（P0 overlay 是 Agnes 唯一风格杠杆）。** 严禁把 styleAnchor 接进 Agnes referenceImages。

## 方法

- 锚图（风格参考候选）：`uploads/images/agnes/shot-9-2b94c5d2-….png`——极鲜明的**冷蓝青色调 / 低调布光 / 深阴影 / 极端特写手部按鼠标**构图。
- 测试 prompt（与锚图最大反差）：`a bright cheerful sunny daytime picnic in a green flower meadow, red checkered blanket…, clear blue sky…, wide establishing shot`——暖亮 / 户外 / 广角，与锚图冷暗室内特写全维度相反。
- 对照：同 prompt、同 seed=12345、`skipTranslation:true`；A 无 referenceImages，B 带上述锚图绝对路径。单一变量=参考图。
- 判据：B 若"保留野餐主体 + 染上冷青电影调"=风格迁移成立；若"冒出锚图的手/鼠标/暗调/构图"=内容渗漏。

## 结果

| | 风格（色调/光影） | 主体 | 构图 |
|---|---|---|---|
| A（无锚） | 明亮暖调插画风 | 野餐（毯/果/三明治/篮） | 广角俯视，照 prompt |
| B（有锚） | **仍是明亮暖调插画风——锚图冷青调完全未迁移** | **野餐场景中被合成进锚图那只按鼠标的手+鼠标+拖线** | **右侧极端特写手部=锚图原构图** |

产物（本地，uploads gitignored）：A=`shot-2-a60939f9-….png`，B=`shot-2-2f9e1a5b-….png`，锚图=`shot-9-2b94c5d2-….png`。

B 的失败方式比预期更彻底：不仅没迁移风格，还把锚图的**内容与机位**原样嫁接。provider 在有 referenceImages 时切到 `agnes-image-2.0-flash`（agnesImageProvider.ts:44），仍是此语义。

## 对路线的影响

- **P1-B（双端注入）改为单端**：ComfyUI IPAdapter 做真风格锚点；Agnes 端锚图注入**取消**，维持 P0 的 prompt overlay。
- **交付策略据此收紧**（与用户原结论一致）：Agnes 空镜的风格统一只能靠 overlay 文本（弱杠杆），无锚图强约束；交付级严格统一以 ComfyUI 配方为准，Agnes 镜发现明显漂移用批准的 ComfyUI 配方重生。
- **P1-A 资产层不受影响**：项目独立风格锚图的存储/版本仍需要（ComfyUI 侧要消费；P2 定稿门"同锚图版本"要判定）。P1-A 任务书红线（零注入）继续有效。

## 待 CC 后续

- ComfyUI 侧 IPAdapter / style-reference 节点映射能力调研（现有工作流预设能否挂 IPAdapter 风格分支、与 PuLID 身份分支共存）——P1-B 立项前置，本轮未做。
- 本 A/B 为单次但视觉无歧义（锚图的手+鼠标字面出现在输出）；如需更强证据可加不同锚图复跑，结论预期不变。
