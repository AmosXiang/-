# 任务书（Codex）：WP-Animatic 分镜动态预览播放器

> 全文直接粘贴给 Codex。上下文自包含。
> 方案依据：`docs/ui-redesign/video-lab-plan-2026-07-15.md` §二。交付域独立 WP，**不属于 Video Lab**。
> 分工：本包归你（coding+验证+提交）；CC review + App.tsx 接线 + 回归。
> 基线 `feature/camera-derive@226ec80`。分支：`git worktree add -b feat/animatic ../wt-animatic 226ec80`（强制独立 worktree）。

## 一、数据契约（形状锁定，Video Lab M1 起复用同一组件）

```ts
// src/components/animaticPlaylist.ts 导出
export type AnimaticItem = {
  shotId: string;
  durationSec: number;       // 组装时已兜底，播放器可信任 > 0
  imageUrl?: string;         // 定稿分镜图（本地 /uploads/...）
  videoUrl?: string;         // 定稿视频；M0 阶段恒为 undefined，接口先留
  finalVideoTaskId?: string; // M2 起使用；播放器只透传不解释
};
```

**播放规则（方案拍板）**：`videoUrl` 存在 → 播放视频（`onEnded` 推进，`durationSec` 作超时兜底）；否则展示 `imageUrl` 计时 `durationSec`；两者皆无 → 显示占位卡（镜头号 + "无定稿图"）并照常计时，不跳过不报错。

## 二、交付物（两个新文件 + 各自测试）

### 1. `src/components/animaticPlaylist.ts` — 纯函数，无 React

```ts
export function buildAnimaticPlaylist(shots: Shot[]): AnimaticItem[]
```

- 图片取值链（与交付包 finals 语义一致）：`finalizedImageUrl ?? generatedImageUrl ?? imageUrl`；
- `durationSec` 缺失/非正数 → 兜底 3；`shotId` 用 `shot.id`，缺 id 的 shot 跳过；
- **不读 legacy `shot.videoUrl`**（旧 Kling 字段无定稿语义，方案 §四.2 定稿指针到 M2 才有）——`videoUrl` 恒不填；
- import `Shot` 自 `src/types.ts`，不改 types.ts。

### 2. `src/components/AnimaticPlayer.tsx` — 播放器组件

Props（签名不写显式 `JSX.Element`，仓库无 @types/react）：

```ts
{ items: AnimaticItem[]; activeShotId?: string; onShotChange?: (shotId: string) => void; onClose?: () => void }
```

- 播放/暂停、上一镜/下一镜、点击时长比例分段进度条跳转任意镜头；
- 显示：当前镜头序号/总数、当前镜头已播秒数/该镜头时长、全片总时长；
- 每次切换镜头调用 `onShotChange(shotId)`（分镜列表联动由 CC 接线消费）；`activeShotId` 变化时跳转到对应镜头（外部反向联动）；
- 计时用 `requestAnimationFrame` 或 `setInterval` 皆可，但暂停必须冻结进度、组件卸载必须清理定时器；
- 图片用 `<img>`（object-fit: contain，黑底）；`videoUrl` 分支用 `<video>`（muted、自动播放当前项、`onEnded` 推进）——本期无真实视频数据，分支逻辑写好即可，验收用测试与手工构造 item 覆盖；
- 样式随暗色工作台（参照 StoryboardReview 的全屏遮罩风格），不引新依赖、不加全局 CSS（组件内 style 或 index.css 已有 token 类）。

### 3. 测试

- `animaticPlaylist` 走 node:test（纯函数，无 DOM）：取值链优先级、durationSec 兜底、缺 id 跳过、legacy videoUrl 不透传、空数组；
- AnimaticPlayer 无 DOM 测试基建，不强求单测；把推进/跳转/清理逻辑尽量提成可测纯函数（如 `nextIndex(current, total)`、`elapsedToShot(items, seconds)`）随 playlist 测试覆盖。

## 三、边界（违反即返工）

- **允许新增的文件仅限**：§二两个源文件、其测试、§四的验收证据文档（`evidence/animatic-acceptance.md` 及其截图）——此外零新增；**禁碰 App.tsx、server.ts、router.ts、main.tsx、types.ts、任何 server/modules/**——主工作区当前有他人未提交的 App.tsx/server.ts 等改动，你从干净基线拉的 worktree 看不到它们，碰了必然合并冲突；挂载接线全部由 CC 做；
- App.tsx 里已有旧的 `animaticVideoUrl` 合成 MP4 功能，与本包的前端混合媒体播放器**不是同一功能**，不要复用、不要重构它（App.tsx 本就禁碰，此处仅防误解）；
- 不新增后端 API、不接任何视频 Provider、不改 Video Lab 数据模型（方案 §二明确）；
- 不加 npm 依赖；正式 db.sqlite 与 uploads 零污染。

## 四、验收

- 自动化：`npm run lint`（tsc --noEmit）+ `npm run build` + `npx tsx --test` playlist 测试全过；
- 组件可视验证：写一个临时 demo 挂载（如临时改 main.tsx 本地跑，**提交前还原**）或提供 Storybook 式独立预览均可，截图存证：≥3 镜头播放中、暂停态、点击分段跳转后、占位卡分支；
- 证据：`docs/ui-redesign/tasks/evidence/animatic-acceptance.md`（含截图与测试输出）；
- 提交前缀 `feat(animatic): ...`，不 push，完成通知 CC。

## 五、CC 接线备忘（非 Codex 范围，review 时核对接口够用即可）

交付步骤（第④步，DeliveryPanel 上方）加"▶ 动态预览"入口，全屏打开 AnimaticPlayer；`items = buildAnimaticPlaylist(generatedScript.newShots)`；`onShotChange` 联动分镜列表高亮。
