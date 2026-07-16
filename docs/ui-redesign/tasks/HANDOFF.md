# UI 重设计 — 会话交接（2026-07-16 · 全批次收官）

> 新对话开场把本文件读一遍即可接续。协调人 = CC（Claude Code）；重活外包给 Codex/Antigravity。

## 现在在哪

- **主线分支**：`feature/camera-derive`，HEAD = `85d4bfe`，工作区**干净**（草稿已清、完结 worktree 与分支已清）。
- **UI 重设计全批次完成**：P0 止血 → P1 路由 → P1b 布局 → P2a 故事版本/定稿 → P2b 交付导出 → **P3 风格契约+参数快照+检查器五区** → **P3.5 场景参考轻量版** → **P4 角色资产+README** → **P4b scenes/+Unicode**。
- **用户四大痛点已闭环**：①上传优先首页 ②分析/创作结构分离+路由化 ③画风统一（项目级风格契约锁 preset/overlay/宽高/LoRA，分镜只开结构参数，批量生成硬闸门，每次生成留参数快照）④交付物（PPTX 分镜手册 + manifest + finals/ + characters/ + scenes/ + README）。
- 远期未排：Video Lab（集成计划裁决 #12，分镜链路已稳，随时可从 `storyboard-manifest.json` 接上）。

## 已合入工作包（全部 review PASS）

WP-B(shot-review) · WP-C(export-deck) · WP-E(story-version) · WP-F(delivery-ui) · WP-G(style-contract) · WP-H(p3-wiring) · WP-I(scene-reference) · WP-J(export scenes/+Unicode) · WP-P4(角色资产)，加 CC 自做的 P0/P1/P1b 与全部接线/集成/回归。

## 权威文档（都在 `docs/ui-redesign/`）

- 方案 v2.1：`workflow-redesign-2026-07-14.md`
- 集成计划 + 12 项设计裁决 + 批次表 + 协作纪律：`tasks/integration-plan-2026-07-14.md`
- 各工作包契约：`tasks/codex-*.md`、`tasks/antigravity-*.md`
- 验收证据：`tasks/evidence/*.md`（每个工作包一份）
- CC 持久记忆 `workflow-redesign-2026-07`，状态同步。

## 铁律（踩过坑固化的，务必守）

1. **主工作区归 CC；外部 agent 强制 `git worktree add`**，禁止在主工作区切分支——违反过一次，CC 的提交落错分支，做过手术。**热区规则（2026-07-15 用户拍板）**：前端热区（App.tsx 等）可向 Codex 放权，但仅限任务书列明的区域，CC 逐行严审；分工 = CC review/合并/回归，Codex+Antigravity coding/验证/提交。
2. **视觉/交互验收以复核方(CC)为准**，agent 自报 PASS 不作数（Antigravity 自报 COM 渲染通过却没拦住画布越界，就是这条的由来；后续多次靠这条拦下 overlay 双注入、证据循环论证等问题）。
3. **合并只经集成分支**，CC 统一执行 + 回归(lint + 全量 node:test + 真机冒烟)，再 ff 回主线。
4. 外包套路（已验证 8+ 次）：**Codex/Antigravity 写后端模块 + 独立前端组件 + 任务书授权的热区触点；CC 出精确任务书 + 逐行 review + 接线兜底**。后端模块照抄 `server/modules/camera-derive|style-contract/` 结构；server.ts 每包只许 1 行 import + 1 行 register（引用其导出纯函数如 `resolveEffectiveStyleContract` 可以，改不行）。
5. 组件签名**别写显式 `JSX.Element`**（仓库没装 `@types/react`，会炸类型检查）。
6. 分镜/项目存 SQLite `store` 表 `key='generated_scripts'` 的 JSON，**没有表、禁止建表**；新字段走 Shot/GeneratedScriptRecord 的可选 JSON 字段(旧数据零迁移)。契约/场景等模块字段同此。

## 环境备忘

- dev 启动：Browser 工具 `preview_start {name:"dev"}`（走 `.claude/launch.json`）。vite 端口常被占会自动换，express 后端 = vite 端口 + 1。**绝不用 Bash 跑 dev server**。改后端后需 `preview_stop` 再 `preview_start` 才重载。
- lint：`npm run lint`（= `tsc --noEmit`）。测试：`npx tsx --test <模块>/*.test.ts`（node:test，`:memory:` SQLite + mkdtemp 隔离）。核心 server.ts 无独立测试基建 → 走 db 副本 curl 证据（禁碰正式 db.sqlite）。
- 本机装了 LibreOffice：PPTX 可 `soffice --headless --convert-to pdf` 渲染做视觉复核。中文 zip 解压核验：其 `createExportZip` 产包 + PowerShell `Expand-Archive`（.NET 解码=资源管理器同源）。

## 下一步候选（无强制排期，按需开工）

- **Video Lab**（裁决 #12）：**方案已定稿** → `docs/ui-redesign/video-lab-plan-2026-07-15.md`（v1.0，用户拍板 + CC review 合并）。WP-Animatic（交付域播放器）可立即立项；Video Lab 从 M1 起立项，无需再等。要点：三生成模式作 provider capability 静态声明、沿用 video_tasks 表（已核实追加式，多 Take 无需修复）+ Shot 仅增 finalVideoTaskId、四硬规则（画幅继承/定稿落盘校验/成本闸门/视频默认不进 ZIP）+ 禁止静默降级 + motionPrompt 独立。**WP-Animatic 已合入**（`3dc2777`，Codex dc98b1c review PASS，worktree/分支已清）：AnimaticPlayer + buildAnimaticPlaylist（图链 finalizedImageUrl??generatedImageUrl??imageUrl、3s 兜底、缺 id 跳过、legacy videoUrl 拒传）。CC 复核 = 亲跑三件套 + 临时 demo 真机全交互验证（证据文件有 CC 增补节，含两则工具伪影澄清）。**接线已完成（c56ae25）**：交付步（第4步）"动态预览(Animatic)"入口 + onShotChange 联动 selectedShotIndex；items/回调 useMemo/useCallback 稳定化。**接线时实测修复一缺陷**：74 镜真机播放计时慢 25%——宿主 App 高频重渲染（90f64fd 引入轮询/FPS 类刷新源）连带重建播放器计时 effect、锚点重算累积丢时；修法=计时 effect 依赖收窄为原始值 + elapsedSec ref 锚点（AnimaticPlayer.tsx 内注释详述），修复后 97% 精度。**教训：全屏播放器类组件的计时 effect 依赖必须全为原始值，宿主重渲染频率不可假设。**
  **Video Lab M1 已合入并接线完成（真机全链路 PASS）**：合并 `6b50a21`（Codex 6629e7a review PASS，46/46+9/9 亲验）+ CC 接线 `5fae841`（generation_snapshot_json 迁移、createAgnesVideoTask 内核提取双路复用[直调路径回归逐字一致]、register、App 交付步 Video Lab 覆层）+ 证据增补 `e4c6fc5`。**真机（真实 Agnes，task af994104）**：providers→capability 驱动 UI→409 画幅三选层(1:1→3:2 crop)→真实生成→落盘 426KB→快照完整审计链全过；视频实体 ffprobe H.264+AAC/24fps/3.375s。worktree/分支已清。
  **M2 任务书已出（v1.1 可分发）**：`tasks/codex-video-lab-m2.md`，基线 `f801086`，分支 feat/video-lab-m2。范围=按 shot 查询/Take 并排/finalVideoTaskId 定稿(硬规则 B 五 code 矩阵)/批量+成本闸门(硬规则 C 三数字分开+服务端 confirmed 闸门)。**Animatic 混播定稿视频已被用户裁决砍除**（final-videos 端点+playlist 升级不做，AnimaticPlayer videoUrl 分支休眠；M1 备忘② durationSec 回填顺延 M3 消化）。deps 扩四项回调(mutateDb/listVideoTasksByShot/getVideoTask/isLocalVideoReadable)由 CC 实现。M3 留=视频交付/ZIP/重试 UI/Take 清理。
  **Video Lab M2 已合入并接线完成（真机 PASS，2026-07-16）**：合并 `f010dd5`（Codex 17/17+54/54）+ CC 接线（四 deps：mutateDb 复用/listVideoTasksByShot prepared 查询/getVideoTask=videoTaskRow/isLocalVideoReadable 复用 export-deck naming.ts getLocalPath+isReadableFile）。真机（真实 Agnes）：两镜成本闸门（三数字分开）→409 画幅 crop→批量串行；**Agnes 实测限流 1 req/min**，第二镜真机复现"部分失败保留审计不阻断"后单独重批成功；Take 倒序列表（含失败 Take 红标无定稿按钮）→双 Take 并排原生 video→两镜各自定稿（★徽标/取消/换选/批量列表联动排除）→落库核验双指针+独立 seed 快照一致。**备忘①再证**：定稿实物 ffprobe=1088x832@24fps/81帧/3.375s，provider normalized_size=1152x768 不符。**真机新发现（另立项）**：App 对 generated-scripts/comfyui-tasks 失控轮询（分钟级 1.4 万请求→ERR_INSUFFICIENT_RESOURCES 饿死页面 fetch/媒体），与 M2 无关；M3 备忘=批内节流应对限流。证据 `evidence/video-lab-m2-acceptance.md` §6。
  **工作区未提交改动（2026-07-16 用户核对，来源明确=用户本人的进行中工作）**：6 文件实际新增约 629 行（tracked +576/−84，另未跟踪 src/api.ts 53 行）= 故事创意编辑、分镜重生成、图片加载优化、ComfyUI 打开/工作流下载/PNG 导回/请求恢复等已验证功能（server.ts/App.tsx/ShotVersionPanel/StyleContractReadonly/index.css + src/api.ts）。两任务书已把这些文件划为 Codex 禁碰。**推进顺序（用户拍板）**：①审查落定这批改动 → ②Animatic 开工（226ec80 worktree）→ ③合入后填 M1 基线 → ④启动 M1。另：**Agnes 静态图片 provider（生成分镜图）是独立需求，另开任务书，不混入视频任务书**。
- **风格锚点 IPAdapter**（方案 §六.4，P3 时判为需 ComfyUI 工作流预设扩展而后置）：定稿首图作风格参考注入后续分镜。属"真开放注入"范畴，先确认 manifest/工作流映射能力再评估。
- **场景参考增强**：现为轻量版（纯文本 overlay 注入，图不参与 conditioning）；若需要图像 conditioning 再扩。

## 已知遗留（不阻断）

- **游离分支/worktree**：`.pnpm-store/worktrees/style-contract-integration`（分支 `feat/style-contract-integration@f171884`）**未合入主线**，来源存疑、非本轮 CC 创建——清理前须先确认是否含未合并工作，**勿盲删**。另有 Agnes 相关分支（`codex/agnes-*`、`feat/video-retry-download`）与 `feat/ui-v2-integration`（批次1 旧集成分支，已合入可删）、`fix/fresh-db-import-sha256` 等，均非本轮范围。
- **export-deck 跟进包已合入**（`d362168`，Antigravity bdaaa3d review PASS）：naming.ts 单一事实源（sanitizeFilename/getLocalPath/isReadableFile/sceneExportFile 收编，CC 预比对逐行等价后授权直并）+ emoji 截断 fixture 补真（18 码点、边界落 ZWJ 序列首码点）+ manifest↔zip 双向一致性回归用例（含角色目录抽查）。CC 复核全套：自跑 lint/build/6为6、真机 zip Expand-Archive 零乱码（证据 `evidence/export-deck-followup-acceptance.md` §4）。合并后全模块 37/37（=旧 36 + 新增 1）。worktree/分支已清。**遗留记录（P3 级，未立项）**：manifest.shots[].imageFile 的 `finals/shot-XX` 模式（generator.ts）与 routes.ts finals 拷贝疑似同类双推导，未来评估是否收进 naming.ts。
