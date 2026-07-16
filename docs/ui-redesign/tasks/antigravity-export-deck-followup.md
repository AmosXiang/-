# 任务书（Antigravity）：export-deck 跟进包 — manifest/zip 单一事实源 + emoji 截断测试补真

> 全文直接粘贴给 Antigravity。上下文自包含。
> 来源：HANDOFF「已知遗留 P3 级小项」两条，趁 WP-Animatic 开发窗口清掉。整包限定 `server/modules/export-deck/` 模块内部，与进行中的 wt-animatic（只新增 src/components 文件）和主工作区未提交改动（用户本人工作，App.tsx/server.ts 等）零交集。
> 分工：本包归你（coding+验证+提交）；CC review + 回归。**验收以复核方 CC 为准，自报 PASS 不作数。**
> 基线 `feature/camera-derive@1c7d4ff`。分支：`git worktree add -b feat/export-deck-followup ../wt-export-deck-followup 1c7d4ff`（强制独立 worktree）。

## 一、问题一：manifest 与 zip 实物是两份独立推导（漂移即交付物自相矛盾）

现状（已核实）：

- `sanitizeFilename` 存在**两份副本**：`routes.ts:41` 与 `generator.ts:75`（正则今天恰好相同，纯靠人工保持）；
- 场景导出文件名 `${两位序号}_${sanitize(场景名)}${ext}` 的推导逻辑也是两处独立实现：
  - **实际拷贝**：`routes.ts` ~399–414（getLocalPath → isReadableFile → 拼名 → copyFileSync 进 scenes/）；
  - **manifest 声明**：`generator.ts` ~803–817（独立重跑同一套推导写进 `manifest.scenes[].imageFile`）。
- 任何一边改动（正则、补零位数、扩展名兜底）而另一边没跟上，manifest 声明的 `imageFile` 就与 zip 里实际文件名不符——交付物自证失败。

### 修法：提取模块内共享命名层

1. 新建 `server/modules/export-deck/naming.ts`（模块内部文件，不对外导出到 index.ts 之外的消费者），至少导出：
   - `sanitizeFilename(name)`（唯一实现，两处 import）；
   - `sceneExportFile(scene, idx, uploadsDir)` → `{ fileName: string | null, localPath: string | null }`——把"getLocalPath → isReadableFile → ext 兜底 → 两位序号 → 拼名"整段收成唯一实现；`fileName` 为 null 即"无可导出图"。routes.ts 用它的结果拷贝，generator.ts 用**同一结果**写 manifest（`imageFile = fileName ? 'scenes/' + fileName : null`）。
2. `getLocalPath` / `isReadableFile` 若两文件中实现语义一致 → 一并迁入 naming.ts 去重；若存在有意差异 → 保留原状并在 naming.ts 顶部注释说明差异原因（不得顺手"统一"掉语义差异）。
3. 角色目录名 `${两位序号}_${sanitizeFilename(角色名)}`（routes.ts:344）同样改用共享 `sanitizeFilename`；若 manifest 侧对角色也有独立文件名推导，同样收进共享层（自查后在证据里说明处理结果）。
4. **行为零变化是硬要求**：本包是重构不是改名规则，修完后对同一输入产出的 zip 结构与 manifest 内容必须与修前逐字节等价（文件名层面）。

## 二、问题二：emoji 截断测试补真

现状（已核实）：`routes.test.ts:368` fixture role `'勇者🦸‍♂️👑主角'` 按 `Array.from` 计长仅约 9 字符，而 `truncateRole(char.role, 14)`（generator.ts:280）阈值 14——**截断分支从未被测试执行**，该用例对截断逻辑是空转的。

### 修法

1. fixture 改用 `Array.from` 计长 **>14** 且**第 14 字符边界恰好落在 emoji（代理对/ZWJ 序列）上**的角色名（构造时写明计长过程注释）；
2. 断言：输出以 `…` 结尾；`Array.from(输出).length === 15`（14+省略号）；输出不含孤立代理项（`/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/` 与 `/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/` 均不匹配）；
3. 保留原 fixture 覆盖的"短名不截断"路径（可另设短名用例），不要用改长顶掉原语义。

## 三、新增回归测试（锁死问题一不复发）

在 routes.test.ts（或新 naming.test.ts）加一致性用例：构造含中文、emoji、特殊字符场景名的项目 → 走真实导出（mkdtemp 隔离）→ 断言 **manifest.scenes[].imageFile 与 exportDir/scenes/ 下实际文件一一对应**（逐个 `fs.existsSync(path.join(exportDir, imageFile))`），无图场景 imageFile 为 null 且目录中无对应文件。角色目录同理抽查一例。

## 四、边界（违反即返工）

- **只允许改动 `server/modules/export-deck/` 下文件** + 新增证据文档；禁碰 server.ts、App.tsx、src/**、types.ts、router.ts、其他 server/modules/；
- 不改 index.ts 对外导出面（新增 naming.ts 的导出仅供模块内部 import）；不加 npm 依赖；不建表；
- 正式 db.sqlite 与 uploads 正式目录零污染（测试全走 `:memory:` + mkdtemp）；
- 文件名生成规则**零语义变化**（§一.4）；发现两副本已有语义分歧 → 停工报 CC 裁决，不得自行择一。

## 五、验收

- 自动化：`npm run lint` + `npm run build` + `npx tsx --test server/modules/export-deck/*.test.ts` 全过（含新增一致性用例与补真后的截断用例）；
- 自证：证据文档中列出 ①naming.ts 收编清单（哪些函数从哪两处迁来、diff 说明语义未变）②emoji fixture 的 Array.from 计长演算 ③一致性用例输出；
- CC 复核：真机导出一次含中文+emoji 场景/角色名的项目，PowerShell `Expand-Archive` 解包对照 manifest（沿用 WP-J 验收管线）；
- 证据：`docs/ui-redesign/tasks/evidence/export-deck-followup-acceptance.md`；
- 提交前缀 `fix(export-deck): ...`，不 push，完成通知 CC。
