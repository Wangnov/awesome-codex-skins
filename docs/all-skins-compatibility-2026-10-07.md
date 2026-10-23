# 2026-10-07 全皮肤 UI 兼容修复

本次将已在 Elon Mars Protocol 1.2.1 验证的兼容处理推广至其余 49 套公开皮肤，并以 1.2.2 为试点皮肤追加下拉箭头与标志的间距修正。配套运行时为 Codex App Manager 0.5.13 或当前 Studio；仅导入皮肤到旧运行时无法获得完整兼容。

## 修复内容

- 三种工作区标志使用常显伪元素，标志按钮可收缩并为相邻控件及 chevron 留出空间，悬停和键盘聚焦时也不会交叠。
- 首页与空间导航直接使用每套皮肤自己的 Folder／Sites 位图素材。
- 发送道具、SVG 隐藏及 hover／disabled 规则仅匹配发送操作，语音与停止保留原生图标。
- 修复历史 ChatGPT 标志误嵌套规则，缺少专用素材时回退到同主题 Work 标志。
- 各主题既有背景、浮层和 IP 素材继续使用；活动页面及弹层稳定性由配套运行时处理。

## 验证方式与记录边界

`cd studio && npm run check && npm test && npm run test:browser`。浏览器回归使用当前 Codex DOM 的最小夹具和真实注入 payload，覆盖整库 50 套；打包仍通过同一 `pack` 门禁。夹具证据用于兼容回归，不能替代逐套真实 Codex 视觉验收。

本次保留现有真实预览和 `codexVerified`，没有把测试夹具截图登记为官方预览。深浅模式、三种标志、不同侧栏宽度、导航图标、发送／语音／停止与活动页／弹窗是回归重点。

## 本次皮肤版本

| 皮肤 ID | 原版本 | 新版本 |
|---|---|---|
| `asuka-eva02` | 1.2.0 | 1.2.1 |
| `caishen-jubao` | 1.2.0 | 1.2.1 |
| `celestial-court` | 1.2.0 | 1.2.1 |
| `cyra-sacred-radiance` | 1.0.0 | 1.0.1 |
| `dasiming-soul-passage` | 1.1.0 | 1.1.1 |
| `dilraba-starlight` | 1.2.0 | 1.2.1 |
| `elon-mars-protocol` | 1.2.1 | 1.2.2 |
| `emilia-rezero` | 1.2.0 | 1.2.1 |
| `gu-qinghan-frostbound` | 1.0.0 | 1.0.1 |
| `gundam-rx78` | 1.0.1 | 1.0.2 |
| `guts-terminal` | 1.2.0 | 1.2.1 |
| `han-li-mortal-path` | 1.0.0 | 1.0.1 |
| `hancock-onepiece` | 1.2.0 | 1.2.1 |
| `jay-chou-inkstone-rhapsody` | 1.2.0 | 1.2.1 |
| `jensen-infinite-compute` | 1.2.0 | 1.2.1 |
| `ji-canghai-blazing-gallant` | 1.0.0 | 1.0.1 |
| `jj-lin-soulwave-sanctuary` | 1.2.0 | 1.2.1 |
| `journey-to-west` | 1.2.0 | 1.2.1 |
| `kakashi-naruto` | 1.2.0 | 1.2.1 |
| `kaworu-mark06` | 1.2.0 | 1.2.1 |
| `kun-afterglow` | 1.2.0 | 1.2.1 |
| `kurumi-sunward-onmyoji` | 1.0.0 | 1.0.1 |
| `lan-meng-caiyun-trick` | 1.0.0 | 1.0.1 |
| `luffy-onepiece` | 1.2.0 | 1.2.1 |
| `luo-feng-domain` | 1.0.2 | 1.0.3 |
| `mai-shiranui` | 1.2.0 | 1.2.1 |
| `marco-polo-clockwork-expedition` | 1.1.0 | 1.1.1 |
| `ming-imperial` | 1.2.0 | 1.2.1 |
| `naraka-wanxiang-cangdi-fourfold-axis` | 1.0.0 | 1.0.1 |
| `naraka-wanxiang-five-aspects` | 1.0.0 | 1.0.1 |
| `naraka-wanxiang-kuishi-mountain-seal` | 1.0.0 | 1.0.1 |
| `naraka-wanxiang-minghuo-abyssal-tide` | 1.0.0 | 1.0.1 |
| `naraka-wanxiang-shuojin-thunder-forge` | 1.0.0 | 1.0.1 |
| `naraka-wanxiang-yuyan-ember-prison` | 1.0.0 | 1.0.1 |
| `ning-hongye-crimson-night` | 1.1.0 | 1.1.1 |
| `rei-eva00` | 1.2.0 | 1.2.1 |
| `rem-rezero` | 1.2.1 | 1.2.2 |
| `san-tibo` | 1.2.0 | 1.2.1 |
| `shaosiyuan-fateweave` | 1.1.0 | 1.1.1 |
| `shinji-eva01` | 1.2.0 | 1.2.1 |
| `three-kingdoms` | 1.2.0 | 1.2.1 |
| `tianhai-vajra-thunder-temple` | 1.0.0 | 1.0.1 |
| `trump-golden-order` | 1.2.0 | 1.2.1 |
| `underworld-yama` | 1.2.0 | 1.2.1 |
| `western-pure-land` | 1.2.0 | 1.2.1 |
| `wuchen-twofold-transit` | 1.0.0 | 1.0.1 |
| `yao-deer-spirit-grove` | 1.1.0 | 1.1.1 |
| `yu-linglong-foxfire-enchant` | 1.0.0 | 1.0.1 |
| `yu-linglong-mistveil-sorceress` | 1.0.0 | 1.0.1 |
| `zhang-qiling-bronze-gate` | 2.0.1 | 2.0.2 |
