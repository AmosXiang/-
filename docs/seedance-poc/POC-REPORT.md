# Seedance 2.0 视频生成 POC — 阻断状态报告(封存)

状态:**BLOCKED — HNLINK 网关租户授权未落地,零帧生成,¥0 消耗。**
封存日期:2026-07-08。解锁条件与恢复步骤见第 8 节。

## 0. 通道演变史(为什么现在是 HNLINK)

| 阶段 | 通道 | 结局 |
| --- | --- | --- |
| 1 | 火山方舟官方 Ark(中国区) | 用户提供的 `sk_test_`/`sk_live_` key 均为 Stripe 风格,官方端点返回 `401 API key format is incorrect`(方舟 key 是控制台生成的 UUID 风格) |
| 2 | `seedance2.ai` 第三方转发商 | 请求体走到计价环节后 `402 insufficient_credits`(required 60 credits, available 0);且属用户明令禁止的转发商类型,放弃。留档:[poc-runs-seedance2ai-402.json](poc-runs-seedance2ai-402.json) |
| 3 | **HNLINK 中转**(`token.hnlink.net`,ylrzcloud 贴牌实例) | **当前通道**。请求/响应与官方 Ark 同构,key 鉴权通过,¥20 余额在账,但租户级模型授权缺失 → 403,本 POC 在此阻断 |

**结论定级不变**:HNLINK 仍是第三方中转,本 POC 产出定级为"**能力探路**"。
但有一处定性上修:HNLINK 计费单位与官方同构(按 token,见第 4 节),成本数据对
官方接入决策的参考价值比 seedance2.ai 阶段(credits 计价)高。

## 1. 已确认的 API 格式(HNLINK 文档截图 + 零成本实测交叉确认)

- **创建任务**:`POST http://token.hnlink.net/api/gateway/api/v3/contents/generations/tasks`
  (注意:**HTTP 明文**;HTTPS 证书是 `admin.tokens.ylrzcloud.com` 的,坐实贴牌+明文风险)
- **鉴权**:`Authorization: Bearer sk-...`(`sk-` + 24 位十六进制,非方舟 UUID 风格)
- **请求体**(文档截图确认,与官方 Ark 同构):
  - `model`(必填):`seedance2.0` —— **平台别名**,不是官方的 `doubao-seedance-2-0-260128`
  - `content`(必填):多模态数组,type 支持 `text` / `image_url` / `video_url` / `audio_url`
  - 顶层可选参数(**不是**文本指令):`duration`(4-15 秒,-1 自适应)、
    `ratio`(支持 9:16,竖屏短剧用这个)、`resolution`(480p/720p/1080p)、
    `watermark`(默认 false)、`generate_audio`(默认 false)
- **响应**:`{"id":"video_xxx","status":"queued"}` **或** `{"id":"cgt_xxx","status":"queued"}`
  —— 任务 id 有 `video_` / `cgt_` **两种前缀**,均为异步任务
- **查询端点**:`GET .../api/v3/contents/generations/tasks/{id}`。创建文档没写查询端点,
  已零成本实测确认存在:探针查不存在的任务返回业务 404「任务不存在或已过期」
  (非鉴权错),与官方 Ark 同构。两种前缀的 id 走同一查询端点。
- **网关信封坑**:业务错误可能包在 HTTP 200 + `{code,msg,data}` 信封里,成功可能是
  原生 Ark 形状响应——脚本 `unwrap()` 两者都处理。

## 2. 人像库链路(ref 模式,`asset://`)

文档已确认完整链路,但**本轮未走通**:

1. 建**虚拟人像文件夹**(`kind=virtual`,免活体检测);
2. 向文件夹**上传人像**——接口只收**公网 HTTPS URL**,不收本地文件/base64;
3. refresh 后拿到 `asset_id`;
4. `content` 里 reference_image 用 `asset://<approved_asset_id>` 引用。

**阻断点**:我们的角色定妆图是本地 ComfyUI 产物(`uploads/projects/.../characters/*.png`),
没有公网 HTTPS 托管。解法(恢复时二选一):用户手动把定妆图传到任意 HTTPS 图床把 URL
给脚本;或本轮只测纯文本模式(上一轮的既定决策)。脚本里保留了 data URI 尝试代码,
但文档口径是不收 base64,预期无效,仅作实测备用。

## 3. 403 诊断全过程

三层探针 + 授权操作后复测,全部发生在计费前(**¥0 消耗**,Dashboard Monthly Calls: 0 可交叉验证):

| 步骤 | 探针 | 结果 |
| --- | --- | --- |
| 1 | 鉴权(GET 查不存在的任务) | ✓ 业务 404「任务不存在」,非 401 → **key 有效** |
| 2 | 视频模型 `seedance2.0` 创建任务 | ✗ `403 模型未分配给当前租户,请联系管理员开通后再调用` |
| 3 | 聊天模型 `qwen3.5-flash`(max_tokens=1) | ✗ 同样 403 → **租户级无任何模型授权**,不是视频模型单独的问题 |
| 4 | 用户在 Model Hub 做"开通"操作后复测 | 403 不变 |
| 5 | 后台轮询(30 秒/次 × 10 分钟) | `STILL-403` → 排除授权传播延迟 |

**5 个模型名变体探针结果**:

| 模型名 | 网关响应 |
| --- | --- |
| `seedance2.0`(文档标准名) | 403 未分配给当前租户 |
| `Seedance2.0` | 403 未分配给当前租户 |
| `seedance-2.0` | 403 未分配给当前租户 |
| `doubao-seedance-2.0` | 403 未分配给当前租户 |
| `Seedance 2.0`(带空格,Model Hub 卡片显示名) | **400 未配置计费规则**(目录里存在但没挂计费) |

**矛盾点定性**:Model Hub 卡片显示"已开通"并给出专属费率(见第 4 节),但网关坚持租户
未分配 → **Model Hub 展示与网关租户授权是两套账**,卡片只是目录+报价。key 级已排除
(API Keys 页面只有 Daily Limit,无模型范围配置项;也试过"新建 key 快照授权"假设)。
平台是 ylrzcloud 贴牌,真正的租户授权大概率在上游运营方手里,不在用户的管理员面板里。

## 4. 价格表数据(⚠️ 标注单位存疑,未经真实扣费验证)

Model Hub 显示的专属费率:**480P/720P ¥41.4**。

- 页面标注口径为 **/M tokens**(与官方 ¥46/M tokens 同构、还低 10%)——若属实,
  按 token 公式 `时长 × 宽 × 高 × 帧率 / 1024`(24fps)估算,单次 480p/4s/9:16 约 **¥1.6**,
  ¥20 余额可跑满 6 次矩阵有富余;
- **但该单位从未被真实扣费验证过**(所有调用都被 403 挡在计费前)。若实际是 **/次**,
  单次 ¥41.4,余额连一次都不够。**恢复后第一件事就是单次探路调用核对真实扣费**,
  在扣费口径确认前不得规划多次调用。

## 5. 分镜 → 时序 prompt 转换(已完成,dry-run 验证)

**素材**:生成项目 `1782930008056`(「梅」,60 分镜 + 6 角色定妆图),同项目自洽,
ref 模式才成立。(replicability 历史分析用的 3 个参考视频没有定妆图,shot c 的
"高风险"按 rubric 判据现选,非取自历史报告——如实说明。)

**策略**:分层组织,`【画面内容】description → 【运镜】movement 归一化镜头语言 →
【构图】composition → 【氛围】emotion → 【风格】固定后缀`。运镜单列显式指令,
便于客观核对生成结果——这是喂给 rubric 运镜校准的关键变量。

dry-run 实测输出(3 条已验证,示例):

```
【画面内容】梅猛然从一张干净明亮的科研操作台上惊醒，她身穿白色科研服……
【运镜】固定机位,镜头不动
【构图】中景构图
【氛围】惊醒，困惑
【风格】写实电影感,竖屏短剧,高细节。
```

**测试镜头矩阵**(duration 统一钳到平台最小值 4 秒,恰为最低成本档):

| 编号 | 类型 | movement | 定妆图 |
| --- | --- | --- | --- |
| a `shot9` | 基线:单角色简单动作,固定机位 | 固定镜头 | 梅 |
| b `shot1` | 明确运镜:平移跟随+变焦,废墟城市俯视 | 平移跟随+变焦 | 梅(环境镜头,测角色注入行为) |
| c `shot55` | 高风险(rubric 判据):跟踪+多人+快剪打斗 | 跟踪镜头 | 梅+影刃 |

shot c 直接测 rubric `long_tracking_shot`(`calibrationStatus: unverified`)+ 多人同框双重高风险。

## 6. 运镜弱项假设校准数据

**无数据——被授权阻断。** rubric `cameraMotionFeasibility` 的两个假设
(`long_tracking_shot`、`complex_camera_transition`)仍为 `calibrationStatus: unverified`。
这是本 POC 对 shot-analysis 工作最重要的预期产出,目前空缺。

## 7. 接入初判(不变,基于零成本已确认信息)

- **不足以**下"是否值得接入"的结论:真实成本、生成质量/运镜校准两项核心产出为零。
- 工程事实:异步 create→poll 模式与现有 `video-generation.ts` 的 Veo 轮询封装同构,
  接入工程量低;风险全在生成质量与单集成本,必须实测。
- 正式结论仍建议走**官方火山方舟**(实名认证 + 开通 Seedance 2.0 + UUID 风格 Ark Key)重跑,
  HNLINK 数据只作能力探路参考。

## 8. 解锁条件与恢复步骤

**解锁条件**(外部,用户侧):HNLINK 租户拿到 `seedance2.0` 的调用授权——管理员面板
无此入口,需联系平台上游运营方(ylrzcloud 贴牌方/卖账号方):
「请把 `seedance2.0` 模型分配到我的租户,网关报 403 未分配」。

**验证授权已生效**(零成本,不触发计费):

```
npx tsx scripts/seedance-poc.ts --dry        # 先确认脚本仍可运行(纯本地,打印请求体)
npx tsx scripts/seedance-poc.ts --single     # 单次探路:shot a、纯文本、480p、9:16、4 秒
```

`--single` 若返回 403 → 授权仍未落地;若创建成功 → 记下**真实扣费金额**
(核对第 4 节的 ¥41.4 单位之谜),回报后再决定剩余 5 次怎么安排。

**前置检查**:`.env` 里 `HNLINK_API_KEY` 仍为那把 "test" key;若运营方是通过发新 key
的方式开通授权,先换 key 再跑。

**恢复后的既定决策**(上一轮已拍板,不要重新讨论):本轮 ref 模式暂缓(定妆图无公网
HTTPS 托管,见第 2 节),先纯文本;单次探路 → 报真实扣费 → 用户拍板剩余安排。
