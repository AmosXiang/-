# ComfyUI 预设弱项清单——数据挖掘记录与确认结果(2026-07-06)

本文档是 `replicability-rubric.json` 中各已知弱项的证据档案。
数据来源:`comfyui_tasks` 表(挖掘时点:649 任务 = succeeded 463 / failed 97 / cancelled 89,
117 条非空 error)。所有计数可用文中的分组条件复查。

## 一、核心结论:内容驱动的生成失败在历史数据中基本不存在

97 条失败按根因归类:

| 类别 | 数量 | 性质 |
| --- | --- | --- |
| Task timed out after 10 minutes | 41 | 基础设施/性能 |
| missing from queue and history + task lost | 21 | 查询时序 bug(已于 2026-07-06 修复) |
| 重复进程占端口 / comfyui.db 被锁 | 12 | 基础设施 |
| 用户主动取消 / superseded | 18 | 非失败 |
| upload 500 / 连接失败 / 参考图缺失 | 8 | 基础设施 |
| completed without producing an image | 12 | 预设配置问题(见二) |
| node not in API format | 3 | workflow 配置 |
| 写入权限 EPERM | 2 | 基础设施 |

**没有任何一条失败可归因于"画面内容复杂度/prompt 难度"。**

## 二、为什么这是根本性数据缺口(而非样本不足)

1. **扩散模型不因内容难而失败,而是成功产出低质量图**。手崩、文字错乱等质量问题
   在本表中表现为 `status='succeeded'` + 正常保存 imageUrl,对失败统计完全隐形。
2. **12 条 no-image 是确定性配置问题**:全部发生在 `sdxl_legacy`(遗留预设,非 01-04),
   实际仅 3 个不同 prompt;重试复用同一 seed(如"梅"头像 4 次重试均为
   seed 2113606388276156),同 seed 同结果地每次失败——若为内容难度,换 seed
   应偶发成功。判定为该遗留预设的输出节点配置问题。
3. **当前主力 qwen 预设(03)的 17 条失败 100% 为基础设施**(端口锁 9、时序 bug 5、
   连接 1、参考图缺失 1、其他 1)。
4. **架构上不存在"多人同框"生成任务**:pipeline 逐槽生成
   (shot/main 437 条,character 各视角 210 条),多角色互动镜头从不进入单次生成。
5. **运镜零样本**:ComfyUI 只产静帧,运镜失败(若有)发生在视频片段层,不在本表。

## 三、数据能支撑的真实信号

**信号 1:PuLID 身份预设高延迟(采纳,production-data)**
`02_klein_pulid_identity` 失败 52 条中 33 条为 10 分钟超时(63%);
`01_klein_character_master` 失败 12 条中 8 条超时。身份锁定链路是全链路最重、
最易撞超时上限的环节 → 已固化为 `pulid_latency` 弱项。

**信号 2:高重生成压力槽位(仅记录,不作为依据)**
个别槽位被反复重生成(单 shot 槽位最高 47 次,角色"琉璃" front 16 次)。
可能暗示"难一次做对",但与调参/测试行为严重混淆,**未**据此固化任何弱项。

**信号 3:单角色逐槽架构(采纳,architecture)**
多角色同框互动必然拆分或后期合成 → 已固化为 `multi_character_interaction` 弱项。

## 四、用户确认结果(2026-07-06)

| 待确认项 | 结论 | 固化位置 |
| --- | --- | --- |
| 手部动作 | **不是弱项**,不得扣分 | `explicitNonWeaknesses`(显式声明,防止模型凭通用先验乱扣) |
| 清晰文字入镜(招牌/字幕卡/信件文档/手机屏幕/报纸标题) | **确认为真实痛点**:文字模糊、笔画错乱、无法辨认 | `text_in_frame`(user-experience,high) |
| Veo 运镜边界 | **无实测数据**。依据公开文档已知限制作为初始假设(长距离跟踪、复杂机位切换在 8 秒片段内稳定性存在挑战),待 Seedance/Veo POC 实测校准,禁止虚构失败率数字 | `cameraMotionFeasibility` 维度整体标注 `calibrationStatus: unverified` |
| PuLID 高延迟作为扣分项 | **采纳**(63% 超时占比数据扎实) | `pulid_latency`(production-data,medium) |

## 五、明确未纳入的假设(诚实边界)

- 任何"具体运镜类型 → 失败率"数字:零实测样本,禁止出现在报告中;
- "多人/复杂手部导致生成失败":扩散层表现为烂图而非失败,历史表无法证实,
  且手部已被用户确认为非弱项;
- 任何"prompt 措辞 → 失败率"映射:数据不支持。
