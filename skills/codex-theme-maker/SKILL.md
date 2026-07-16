---
name: codex-theme-maker
description: 为 Codex 桌面应用制作「素材化 UI」主题皮肤（AI 生成位图素材 + CSS + CDP 注入，不改应用文件）。当用户想给 Codex app 做新主题、换肤、把一张概念图/截图/IP 风格还原成 Codex 界面、或迭代 Codex-Theme-Studio 里的现有主题时使用。触发词如：Codex 主题、Codex 皮肤、Codex 换肤、概念图还原 UI、theme studio、做一个 XX 风格的 Codex。
---

# Codex Theme Maker — 从零做出「迪迦奥特曼主题」水平的 Codex 皮肤

你（Agent）将把一张概念图或一种 IP 风格，变成 Codex 桌面应用里**完整、可交互、可开关**的素材化主题。本文是完整作战手册：跟着七个阶段走，每一步的工具、参数、坑都已为你踩平。基准线是内置主题 `guts-terminal`（迪迦奥特曼 TPC/GUTS 指挥终端）——做完后你的主题应达到同等水平。

**最终交付物不是主题目录，而是一个 `.codexskin` 包**（Phase 6 产出）——它是 Codex App Manager 的画廊、导入与后续云端分发消费的统一格式。验收通过但没有打出 `.codexskin` 的主题视为未完成。

## 什么叫"迪迦主题水平"（验收基准）

- **素材化而非调色**：背景、输入台、卡片、全部 icon、品牌 Logo、按钮道具都是 AI 生成的位图素材；文字全部是活的原生 DOM（素材上绝不烙文字）。
- **全覆盖**：首页、对话页、设置页、侧栏、右栏、底部面板、浮层菜单、tooltip 无一处漏网原生样式。
- **深浅双模式**：跟随 Codex 外观设置自动切换，两种模式下所有文字可读。
- **零破坏**：所有交互正常、无新增滚动、无布局位移、无闪烁；`off` 一键完全还原原生。
- **有惊喜**：开屏动画、双态按钮（如神光棒开壳=可发送/收拢=禁用）这类叙事细节。

## 依赖（开工前必须确认）

1. **工作台**：[awesome-codex-skins](https://github.com/Wangnov/awesome-codex-skins) 仓库的 `studio/`——CLI、注入器、运行时都在这里，参照皮肤在同仓库 `skins/guts-terminal`。定位顺序：环境变量 `CODEX_SKINS_REPO` → `~/awesome-codex-skins` → 询问用户 clone 位置（`git clone https://github.com/Wangnov/awesome-codex-skins`）。下文所有 `node bin/codex-theme.mjs …` 均在 `<repo>/studio/` 下执行；皮肤目录为 `<repo>/skins/<id>/`（CLI 自动定位，可用 `CODEX_SKINS_ROOT` 覆盖）。
2. **素材生成——任选其一**：优先 [gpt-image-2-skill](https://github.com/Wangnov/gpt-image-2-skill)（开源，含品红底抠图与 alpha 验证管线，`node <skill>/scripts/gpt_image_2_skill.cjs --json ...`；开工按其 runtime freshness 规则检查版本，再跑 `config inspect`、`doctor`、`auth inspect`；**Provider 不做假设**：用 `--provider auto`，全局参数放在 `images edit` / `transparent generate` 等命令组之前）。在 Codex 环境下也可 fallback 到 Codex 自带的 image generation 能力——生成质量要求不变，但抠图/验证需自行走本仓库 `scripts/` 的 Python 管线。**无论哪个引擎，素材硬约束（品红底、无文字、2MB 上限、alpha 验证）一律不变。**
3. **运行环境**：macOS、Node ≥ 20（系统 node 或 Codex 自带 `Contents/Resources/cua_node/bin/node`）、官方 Codex.app（bundle id `com.openai.codex`）、Python3 + Pillow（素材后处理）。

## 七阶段管线

### Phase 0 — 预检
`doctor` 通过；`node bin/codex-theme.mjs status` 看工作台状态；概念图放入 `reference/`。没有概念图时，先与用户确认风格意象（IP、配色、材质、标志性道具），可先用 gpt-image-2 生成一张概念图请用户确认。

### Phase 1 — 设计拆解（最重要的决策阶段）
把概念图拆成两层，输出一张「素材清单 × DOM 部件映射表」再动手：
- **位图层**（AI 生成）：墙面/氛围背景、立绘、输入台 deck、卡片屏、icon 集（16 个功能位）、品牌 Logo 艺术字、标志性道具按钮、水印、小胶囊底。类型学与规格见 [references/asset-pipeline.md](references/asset-pipeline.md)。
- **DOM 层**（CSS + 装饰层）：所有文案、进度条、状态灯，以及 stage/overlay 双装饰层的内容。
- 背景必须**分层**（墙面 cover / 立绘右下锚定 / 台面 CSS 绘制），不要一张大图 cover 到底——窗口变形时会漂移。

### Phase 2 — 素材生产
全流程（生成 → 品红底 chroma 抠图 → alpha 归一化 → 严格验证 → optical bbox 裁剪 → WebP → 入库登记）按 [references/asset-pipeline.md](references/asset-pipeline.md) 执行。要点：**有界并发**、单任务超时、JSON Events 可观测、失败逐项汇总；构图或造型不合适就重生成，透明阴影/边距问题则在素材层归一化，禁止用 CSS 为不同坏 bbox 分别打补丁；道具类优先用实物参考图；**单素材 data URL 必须 < 2MB**。

### Phase 3 — 主题组装
`themes/<id>/`：`theme.json`（schemaVersion 2：colors/strings/assets 映射 + `codexTheme` 原生主题块）+ `theme.css`（全部选择器挂 `html.codex-theme-studio` 前缀）+ `chrome.html`（stage/overlay 双层装饰）。`codexTheme` 块让未被素材覆盖的控件（下拉、字体、accent）也吃到主题——素材化 UI + 原生主题变量是组合拳，缺一不可。写 CSS 前**通读** [references/css-recipes.md](references/css-recipes.md) 的 DOM 地图与全部配方，能省十轮调试。三个约定：开屏素材登记为 assets 的 **`"intro"`** key（runtime 按此播放）；主题的默认外观写 `codexTheme.appearanceTheme`（CLI 在重启流程写入 config.toml）；hero 文案与开屏动画都要用**该 IP 自己的符号与仪式**（NERV 用它的 motto、EVA 用弹射发进），不要套用前作主题的格式。

### Phase 4 — 注入迭代
```bash
node bin/codex-theme.mjs start --theme <id>   # 首次：启动 Codex(CDP)+守护+原生主题写入
node bin/codex-theme.mjs use <id>             # 每次改完主题文件：热重载
node bin/codex-theme.mjs screenshot /tmp/s.png
```
循环：改 → use → 截图 → 与概念图并排对照 → 修。样式不生效时按 css-recipes 的「调试方法论」用 CDP 查 computed style / 层叠 / 裁剪，**不要猜**。改了 `src/`（非主题文件）必须 `stop` + `start` 重启守护。

### Phase 5 — 全面验收（全过才算完成）
1. `verify --screenshot` pass；但不能只信总布尔值：截图前等待 `#cts-intro` 消失，并断言当前真的是目标路由（首页验收时 `.cts-home`、`.cts-home-shell` 与建议卡同时存在）。`off` 后做**属性级零残留**（class/style/装饰层 + `[data-cts-glyph]/[data-cts-icon]/[data-cts-logo]` 计数全 0）；`use` 恢复；CDP 发 `Page.reload` 后守护自动重注入。
2. 逐页走查：首页、对话页（含消息操作行不被挡）、设置页、**右栏展开态**、聊天浮窗、下拉菜单、tooltip——两种外观模式各一遍（外观在设置页用 CDP 鼠标事件切）。
3. 交互硬指标：`composer.scrollWidth-clientWidth === 0 && scrollHeight-clientHeight === 0`；首页可滚动容器数 0（判据看 computed overflow+实际可滚，不看差值）；四张建议卡的按钮盒与**可见装甲边框**等大；发送道具的可见区域不得与模型、审批、附件等相邻按钮相交；开下拉/弹层无闪烁；所有胶囊/按钮文字可读、可点；原生 fixed 顶栏仍是 fixed（y=0 不重复占位）。
4. 窗口 resize 大小两档截图（真实 resize 或 CDP `Emulation.setDeviceMetricsOverride`）：立绘不被裁、台面不漂移、卡片不被台面盖。
5. 迭代期用户可能同时在用 app——一切 DOM 断言与截图同刻原子采集（见 css-recipes 调试方法论 7/8）。

### Phase 6 — 交付打包（产出 `.codexskin`）

Phase 5 全过之后，把主题变成可分发的交付物。三步：

1. **补全交付元数据**（`theme.json`，全部与 schemaVersion 2 兼容）：
   - `version`：主题自身 semver，首版 `"1.0.0"`，此后每次实质修改 bump；
   - `author`：创作者（字符串或 `{ "name", "url" }`）；
   - `codexVerified`：验收时的 Codex 版本，用 `/usr/bin/defaults read /Applications/Codex.app/Contents/Info.plist CFBundleShortVersionString` 读取，**不要手填**；
   - `appearance`：`"dark" | "light" | "dual"`（`codexTheme` 同时带 dark+light 即 `dual`）；
   - `license`：AI 生成的 IP 风格素材默认写 `"personal-use"`——不明版权的主题**不得**公开分发。
2. **标准预览截图**：先用 CDP 把界面整理到标准态——**侧栏的项目、任务、置顶区全部收起**（DOM 控件按 css-recipes 的侧栏地图定位）、导航到主页、等待开屏动画结束；然后：
   ```bash
   node bin/codex-theme.mjs preview-shot <id>              # → previews/home.webp（封面，1280×800 WebP）
   # 推荐再补一张对话页（先手动/CDP 进入一个对话）：
   node bin/codex-theme.mjs preview-shot <id> --name chat
   ```
   命令会自动断言主页路由与 intro 消失、以 2× 采集后缩至 1280×800、写入 `previews/` 并登记进 `theme.json.previews`（`home` 固定为封面）。单张超 500KB 会给出警告——用 Pillow 降质量重存。
3. **打包**：
   ```bash
   node bin/codex-theme.mjs pack <id>                      # → dist/<id>-<version>.codexskin
   ```
   `pack` 是严格质量门：目录名与 id 一致、`version`/`codexVerified`/`previews` 齐备、预览文件存在且 ≤1MB，任一不满足即退出码 2 并列出问题清单。产物 zip 根即包内容（`theme.json` 在根），Manager 通过「导入主题」按钮 / 拖放 `.codexskin` 消费它。

**交付定义（DoD）**：`pack` 成功产出 `.codexskin` + 向用户报告产物路径、版本、预览图清单。

## 硬约束（违反任意一条即失败）

- 不修改/解包/替换 `app.asar` 或任何应用文件；CDP 仅监听 127.0.0.1。
- 素材上无任何文字/数字/logo 文本（品牌艺术字 Logo 素材是唯一例外——文字本身就是设计对象）。
- 一切可逆：选择器全部挂 `html.codex-theme-studio`；装饰元素只放 `#cts-stage` / `#cts-chrome`；`config.toml` 写入前自动备份（CLI 已内置）。
- 装饰层 `pointer-events: none`，绝不拦截交互。
- 素材一律 WebP + data URL 内联进样式表（禁 blob URL）；单素材 < 2MB。
- 每张透明源 PNG 入库前必须 `transparent verify --strict` 通过：真实 alpha、透明 RGB 已 scrub、边缘留有透明 margin、matte residue 已检查；同组素材还必须以实际渲染尺寸生成 contact sheet 做 optical size 对照。
- `config.toml` 只能在 Codex 未运行时写（CLI 的 start 流程已处理，勿手工绕过）。

## 参考文件

- [references/asset-pipeline.md](references/asset-pipeline.md) — 素材生产手册：类型学、规格表、prompt 模板库、抠图/后处理/9-slice 测量、质量门槛。
- [references/css-recipes.md](references/css-recipes.md) — 注入端技术手册：Codex DOM 地图、核心机制、逐部件配方、深色变体、铁律与调试方法论。**写任何 CSS 前必读。**
- [references/reuse-and-validation.md](references/reuse-and-validation.md) — **以现有主题为底本做新主题时必读**：保留/替换边界、防旧 IP 污染的清理顺序、prompt 继承边界、共享实机隔离、证据分级。
- `scripts/normalize_alpha.py` — 透明 PNG 归一化：清低 alpha、scrub 透明 RGB、裁切并补 margin。
- `scripts/asset_contact_sheet.py` — 按真实 CSS 渲染盒生成成组素材对照图，并输出 alpha/optical bbox 数据。
- `scripts/verify-alpha.py` — alpha 门禁的本地复核实现。
- `scripts/audit-theme.mjs` — 交付前静态审计：schema/引用完整性/体积/2MB 上限/CSS 括号平衡/`--forbid` 旧词扫描。**forbid 词表 = themes/ 下所有其他主题的 id、角色名、机体名、专属 asset key**（逐主题手选会漏——kaworu 首轮漏查 guts 的教训），交付前对每个主题跑一遍。
