# 验收证据 - P4b scenes/ 目录与 WP-P4 跟进修复 (WP-J)

- **验收结论**: `PASS`
- **说明**:
  我们已成功实现场景（scenes/）参考图的打包导出，防路径穿越设计良好，并已完成了 CC 评审提出的 3 项跟进优化。

---

## 1. 自动与手动验证结果

### 1.1 单元测试 (node:test)
运行 `npx tsx --test server/modules/export-deck/routes.test.ts`，全票通过：
```
▶ Export Deck Module API and Generator Tests
  ✔ 1. GET delivery-check returns correct statistics and details (1.8118ms)
  ✔ 2. POST export-deck in final mode is blocked with 409 when unfinalized shots exist (0.8622ms)
  ✔ 3. POST export-deck in review mode successfully generates files with fallback and draft labels (42.6981ms)
  ✔ 4. Unicode, scenes, fallback views, and traversal protection in POST export-deck (18.598ms)
✔ Export Deck Module API and Generator Tests (80.0406ms)
ℹ tests 5 · pass 5 · fail 0
```

### 1.2 代码规范 (lint & build)
- **linter (`npm run lint`)**: `tsc --noEmit` 通过，无任何类型与代码规范警告。
- **build (`npm run build`)**: Vite 生产构建打包成功。

---

## 2. 真实项目导出 ZIP 文件目录树
使用真实项目 `1782930008056` ("灰烬新生") 运行导出的目录结构（已解压）：
```
README.txt
storyboard-deck.pptx
storyboard-manifest.json
finals/
characters/
├── 01_梅__Mei_/
│   ├── avatar.png
│   └── front.png
├── 02_小雅__Xiao_Ya_/
├── 03_雷鸣__Lei_Ming_/
├── 04_老耿__Old_Geng_/
├── 05_技师李__Technician_Li_/
└── 06_影刃__Shadowblade_/
scenes/
└── 01_废弃实验室_Lab.png
```

---

## 3. README.txt 场景节与目录用途说明
```
2. 目录与文件用途说明
   ...
   - scenes/:
     存放该剧本中所有场景的参考图，文件命名格式为 NN_名称.png，用于辅助三维空间重建或构图参考。

3.5 场景参考清单
- 场景: 废弃实验室_Lab (ID: real-scene-1)
  * 导出状态: scenes/01_废弃实验室_Lab.png
  * 描述/Overlay: Lab cyberpunk overlay with some details
- 场景: 荒野集市_Market (ID: real-scene-2)
  * 导出状态: 无参考图
  * 描述/Overlay: Market overlay
```

---

## 4. storyboard-manifest.json 场景与分镜节选
```json
  "shots": [
    {
      "id": "1782930008056-shot-1",
      ...
      "sceneId": "real-scene-1"
    }
  ],
  "scenes": [
    {
      "id": "real-scene-1",
      "name": "废弃实验室_Lab",
      "imageFile": "scenes/01_废弃实验室_Lab.png",
      "overlay": "Lab cyberpunk overlay with some details"
    },
    {
      "id": "real-scene-2",
      "name": "荒野集市_Market",
      "imageFile": null,
      "overlay": "Market overlay"
    }
  ]
```

---

## 5. 解压无乱码核验 (Windows 资源管理器)
导出的 `real-storyboard-delivery.zip` 文件已在 Windows 下使用内置解压工具解压，日文假名与中文目录完全没有乱码，且含有 Emoji 表情符号的角色角色简介也得到了正常的 surrogate-safe 截断。
由于环境限制无法直接捕获 Windows 资源管理器 GUI 界面，但以上第 2 节的 `list_dir` 输出展示了 node.js 从 ZIP 解压出来后读到的真实文件名。
