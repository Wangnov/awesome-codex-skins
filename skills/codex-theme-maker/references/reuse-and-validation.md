# 复用现有主题与验证纪律

参考现有主题制作新皮肤时读取本文件。目标是复用已经验证过的 DOM/交互结构，同时阻止旧角色视觉、旧私有资产和共享运行状态污染新主题。

## 1. 先写保留/替换边界

| 层 | 默认策略 | 说明 |
|---|---|---|
| runtime 与 DOM 标注 | 保留 | `data-cts-glyph`、home shell、stage/chrome 等属于工作台能力 |
| 路由与交互选择器 | 保留并复验 | 设置页、右栏、浮窗、菜单、tooltip、composer overflow 规则 |
| 响应式与层叠规则 | 保留并复验 | clamp、右栏挤压、窄 composer、fixed 顶栏 |
| id/name/description/strings | 全部替换 | 先改元数据，避免后续产物仍被识别成基准主题 |
| colors 与固定色值 | 语义重建 | 先定义新主题 token，再替换 CSS 中的固定 RGB/hex；禁止只做 hue-rotate |
| 角色、背景、卡片、intro、deck | 全部重做 | 这些元素负责主题叙事，不能沿用旧 IP 素材 |
| 通用 icon/Logo/胶囊 | 明确决策 | 允许临时占位；交付前必须生成、重绘或记录为何可复用 |

开始前把表落到 `studio/prompts/<id>-design.md`，至少列出每个 asset key、内容、目标尺寸、透明要求和 DOM 去处。

## 2. 复制后的清理顺序

1. 创建新目录后立即修改 `theme.json` 的 id/name/description/strings。
2. 将颜色 key 改成语义化命名（如 `violet`、`cyan`、`moon`），同步替换 CSS 变量引用。
3. 将角色与私有资产 key 改名；不要让 `--cts-asset-asuka` 之类旧 key 进入新主题。
4. 替换生成素材后，重新测量 composer/deck/pill 的 9-slice。生成尺寸经 provider 回落后，原切片数值必然不可靠。
5. 运行静态审计并用 `--forbid` 指定旧角色、旧机体、旧主题 id 等词。
6. 清理未被 `theme.json` 引用的孤儿素材；需要保留的草稿放 `studio/generated/`，不要塞进交付主题目录。

示例：

```bash
node <skill-dir>/scripts/audit-theme.mjs themes/kaworu-mark06 \
  --forbid asuka,eva02,EVA-02
```

## 3. 素材提示词的继承边界

参考图角色只承担完成度、材质密度、照明和构图层级时，在每个 prompt 显式写：

```text
Image 1 is a style and composition reference only. Do not copy its character,
palette, text, logos, interface widgets, or private symbols.
```

每个独立资产单独生成。卡片可以共享统一材质词，但不能用一张 contact sheet 裁四张交付图。透明素材要求单色背景、主体完整留边、无地面/阴影/反射；生成后仍需跑 alpha 门禁。

## 4. 语义换肤而非全局替色

先建立新色板，再按语义替换：accent、focus、ink、surface、signal、diff、skill。全局字符串替换仅用于机械迁移，之后必须搜索：

- 基准主题角色名、机体名、id 与 asset key；
- 旧主题固定 hex/RGB；
- 注释中的旧叙事（会误导后续 Agent）；
- 被删除素材的 CSS 变量。

位图复用若只靠 `filter: hue-rotate()`，必须在实际渲染尺寸验收；角色、背景、卡片与大面积装甲禁止用滤镜冒充新素材。

## 5. 共享工作区与实机隔离

运行 `status` 后记录 currentTheme、port、watcherPid、Codex PID。若这些值在任务期间被其他进程改动，视为并行任务信号：

- 不执行会替换 watcher 或写 `state.json` 的 `start/use/off/stop`；
- 不退出或重启非本任务启动的 Codex 实例；
- 可用时选择独立 CDP 端口与临时状态目录；否则只完成静态验证并报告实机阻塞；
- 启动前后比较 PID，仅关闭本任务启动的实例；无法归属时不要关闭。

macOS 读取 app plist 使用：

```bash
plutil -extract CFBundleIdentifier raw -o - /Applications/Codex.app/Contents/Info.plist
```

不要假设 `defaults read <plist> <key>` 在所有系统版本都可用。

## 6. 证据分级

交付时分开报告：

1. **静态通过**：schema、CSS/asset/color 引用、体积、alpha、旧词、CSS 结构。
2. **注入通过**：payload 构建、目标 renderer 返回正确 theme id、reload 后重注入。
3. **实机通过**：真实 Codex 截图和逐页交互硬指标。

概念图、生成素材预览、HTML mockup 只能证明视觉方向，不能写成“实机验收通过”。实机失败时保留精确错误与已通过的静态证据。
