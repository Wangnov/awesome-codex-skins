# 注入端技术手册（Codex 26.707.x 实测）

写任何 CSS 前先通读本文。组织顺序 = 新手做主题的顺序：DOM 地图 → 核心机制 → 逐部件配方 → 深色变体 → 铁律 → 调试方法论。

## 一、Codex DOM 选择器地图

| 部件 | 选择器 | 关键注意 |
|---|---|---|
| app 根 | `.app-theme` | 有不透明底，会挡 body 背景——必须透明化 |
| 左侧栏 | `.app-shell-left-panel` | **别带标签限定**：主界面是 `aside.`、设置页左栏是 `div.` |
| 主表面 | `main.main-surface` | 圆角 14px 左上；`overflow: hidden` |
| 设置页内容区 | `div.main-surface` | 与 main 复用 class 不同标签（第三个复用案例） |
| 首页容器 | `[data-testid="home-icon"]` 所在 `[role="main"]` | 运行时自动打 `.cts-home` / `.cts-home-shell` |
| 首页 hero | `.cts-home div:has(> [data-testid="home-icon"])` | 隐藏原生用 `> * { visibility: hidden }`；宽泛后代选择器会误伤卡片文字 |
| 建议卡 | `.cts-home .group\/home-suggestions .grid > div:nth-child(n) button` | 编号用 nth-child 写死（CSS counter 在此结构不可靠） |
| 输入框 | `.composer-surface-chrome` | 原生 `overflow: auto`——一切裁剪/滚动问题之源 |
| 输入框包裹层 | `div:has(> .composer-surface-chrome)` | 同尺寸、overflow visible——deck/神光棒素材都画这里 |
| 选择器胶囊排 | `main button:has([class*="_dropdownLabel"])` | 项目/环境/分支/模型等全部下拉触发器 |
| 胶囊滚动行 | `[class*="horizontal-scroll-fade-mask"]` | 有 overflow 裁剪——见胶囊配方 |
| 发送按钮 | `button[class*="size-token-button-composer"]` | 无 aria-label/testid，此 class 是唯一稳定特征 |
| 首页滚动容器 | `.thread-scroll-container` 与 `[class*="container-type"]` | home 锁滚动要锁后者 |
| 平色面板 token | `[class~="bg-token-main-surface-primary"]` | 右栏/底栏/设置内容的实底——透明化放氛围进来 |
| 浮层 | `[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper] > div, [data-radix-menu-content]` | **禁用 `[data-side][data-align]`**——Radix 把这对属性也打在浮层内部子元素上，会在菜单中间制造色带 |
| 聊天浮窗 | `section[class*="_floatingSurface_"]` | CSS modules hash 会变，用属性包含匹配 |
| ProseMirror placeholder | `.ProseMirror [data-placeholder]::before` | 普通 `::placeholder` 无效 |
| 顶部拖拽栏 | `main > .app-header-tint`（**原生 fixed**） | 绝不能被改成 relative——见配方1 |
| 模型名测量 span | `[class*="_WorkTriggerMeasurement"]`（26.707.9x+） | 隐形 absolute，43px 高探出 composer 底 7px 制造滚动区——锚定翻转 `top:auto; bottom:0` |

CDP 辅助：quick-chat prewarm 是独立空壳 target（URL 带 `initialRoute`），截图/verify 要优先无 query 的主窗口 target。

## 二、核心机制（工作台已内置，理解即可）

- **素材变量**：打包器把素材以 data URL 写进样式表头部 `:root.codex-theme-studio { --cts-asset-<key>: url("data:image/webp;base64,...") }`。**禁 blob URL**（幂等重入 revoke 后 border-image 等晚加载图静默消失）；**单素材 < 2MB**（Chromium URL 上限 2097152 字符，超限静默判无效）。
- **注入指纹**：payload 的 stamp 对**打包产物**取 hash——症状"改了代码页面永远旧样式"= stamp 没变或守护进程还是旧代码（改 `src/` 要 stop+start）。
- **双层装饰**：chrome.html 里 `<div data-cts-layer="stage">`（挂 main 内 prepend，z-0，配合 `main > * { z-index: 1 }`——hero/水印放这里，永不盖浮窗）与 `<div data-cts-layer="overlay">`（fixed z31——只放不碍事的边角件）。
- **原生主题联动**：theme.json 的 `codexTheme` 块（appearanceTheme + light/dark 两份 accent/ink/surface/fonts/semanticColors）由 CLI 在 **Codex 未运行时**写入 `~/.codex/config.toml`（自动备份；运行中写会被 Codex 退出时的回写覆盖）。字体走 `fonts.ui` 全局生效。恢复：`stop --quit-codex` 或 `restore-config`。

## 三、逐部件配方

### 1. 背景分层（响应任意窗口尺寸的正解）

```css
/* app 根透明 → body 铺墙（一切路由兜底，设置页也吃到） */
html.codex-theme-studio .app-theme { background: transparent !important; }
html.codex-theme-studio body {
  background: <veil 渐变>, var(--cts-asset-wall) center / cover no-repeat fixed, <底色> !important;
}
/* main：墙 cover + 水印一层；立绘/台面用伪元素独立锚定 */
html.codex-theme-studio main.main-surface { isolation: isolate; position: relative !important; overflow: hidden !important; }
html.codex-theme-studio main.main-surface::before {   /* 立绘：右下锚定 clamp 尺寸 */
  z-index: -2; right: clamp(-40px,-2vw,0); bottom: clamp(60px,9vh,130px);
  width: clamp(280px,30vw,560px); height: clamp(420px,76vh,840px);
  background: var(--cts-asset-tiga) right bottom / contain no-repeat;
}
html.codex-theme-studio main.main-surface::after {    /* 台面：CSS 渐变条（素材条无法适配任意宽度） */
  z-index: -1; left: 0; right: 0; bottom: 0; height: clamp(170px,24vh,260px);
  background: linear-gradient(<金属渐变>);
}
/* 内容抬到装饰层之上——但必须排除原生 fixed 元素！强制 relative 会把
   46px 的 fixed 顶栏拽回文档流重复占位，视觉= main 顶部一条"渐变横线" */
html.codex-theme-studio main.main-surface > *:not([class*="fixed"]) { position: relative; z-index: 1; }
html.codex-theme-studio main.main-surface > [class*="fixed"] { z-index: 1; }
/* 任务页：veil 减淡版 + 立绘 opacity .15 + 台面隐藏（会穿过 ⌘J 终端区） */
/* veil 同阶铁律（双模式都算数）：body / main(home) / main(非home) / 设置页
   div.main-surface 的 veil 必须【完全同值】。深墙主题下透过率差被放大，
   任何不一致都会在 main 边界显形成一条"渐变横线/色带"。 */
/* 平色 token 面板透明化，氛围透进右栏/底栏/设置页；sticky 例外给渐变到【全透明】的保护
   （两种模式都渐变到 0——固定尾值就是一条色带）。 */
html.codex-theme-studio [class~="bg-token-main-surface-primary"] { background-color: transparent !important; }
/* ⚠️ 透明化只适用于【浅墙主题】（迪迦米白墙）。深墙主题（EVA 石墨墙）下透明
   右栏读作"开洞"：body 墙 fixed 与 main 墙 cover 裁切位不同、台面在栏边截断。
   深墙主题给顶层面板 frosted 玻璃底（氛围仍从 blur 透进来）：
   main div.isolate[class~="bg-token-main-surface-primary"] {
     background: linear-gradient(180deg, rgba(浅底,.90), rgba(浅底,.80)) !important;
     backdrop-filter: blur(14px); border-left: 1px solid <accent 线>;
   }  ← 深色分支换深底。specificity 天然盖过上面的全局透明化。 */
```

### 2. 输入台（deck）——最难部件，照抄结构

```css
/* composer 有 overflow:auto：素材永远画在同尺寸 wrapper 上 */
html.codex-theme-studio div:has(> .composer-surface-chrome) { isolation: isolate; }
html.codex-theme-studio div:has(> .composer-surface-chrome)::before {
  content: ""; position: absolute; inset: -46px -47px -21px -130px;  /* = border-width */
  z-index: -1; pointer-events: none; border-style: solid;
  border-width: 46px 47px 21px 130px;      /* = slice × (composer高 ÷ 素材屏幕区高) */
  border-image: var(--cts-asset-composer-deck) 110 114 51 314 stretch;  /* 无 fill！ */
}
/* 输入区大面积底色交给 CSS（与素材屏幕区同色）——绝对均匀、深浅可调、无素材渐变断层 */
html.codex-theme-studio .composer-surface-chrome {
  background: #1c1e22 !important; border: 0 !important;
  box-shadow: inset 0 2px 8px rgba(0,0,0,.4) !important; overflow-x: hidden !important;
}
```
- 素材负责金属框质感、CSS 负责平色——素材化输入区的最佳分工。
- **fonts.ui 用高行高字体（明朝体/衬线）时**，composer 内 `_WorkTrigger` 行会被撑高溢出（实测 7px 滚动区）——composer 子树 font-family 回退系统字，衬线感留给标题/菜单。
- **右栏打开会横向挤压 composer**：`main:has(div.isolate[class~="bg-token-main-surface-primary"]) div:has(> .composer-surface-chrome)::before` 切成对称窄框（slim deck），宽仪表框会吃掉宝贵宽度。
- 对话页 composer 贴侧栏：换对称窄边 `deck-slim` 素材，且上框收窄（-14px）不挡消息操作行。
- 9-slice 而非 `background 100%/100%`：后者随容器比例变形（格栅被拉扁）。

### 3. 建议卡

button 透明化 + `::before` 贴各自屏幕内容素材（nth-child 分配）+ `::after` 写编号；标题文字加 text-shadow 保证压在发光图形上可读。卡片浮层容器 `div[class*="composer-suggestion-inline-inset"]` 提 `z-index: 2` 防止被台面 veil 盖。
**尺寸铁律**：四个 button 盒等大不代表四张卡“看起来等大”。透明素材里的低 alpha 阴影会把 bbox 撑开，使可见装甲只占画布 85%/90%。入库前必须用相同 optical alpha threshold 裁切，并把四张素材按 button 的真实渲染尺寸排 contact sheet；若装甲框本身比例/厚度不同则重生成，若只是阴影范围不同则重裁，禁止给 nth-child 分别写不同 `background-size` 修补。
**hover 陷阱**：卡 button 原生带 hover token 背景，会压过你的基础透明规则——hover 时素材卡后面浮出一块错位白板。必须写全态透明并借 `.grid` 抬 specificity：
```css
.cts-home .group\/home-suggestions .grid button,
.cts-home .group\/home-suggestions .grid button:is(:hover, :focus, :active, [data-state]) { background-color: transparent !important; }
```

### 4. icon 位图化

runtime 扫描（按钮文本/aria-label/nth 位置）打 `data-cts-glyph="<name>"` 在**控件的第一个 svg 上**（打按钮上会误伤下拉 chevron）：
```css
html.codex-theme-studio svg[data-cts-glyph] > * { opacity: 0 !important; }
html.codex-theme-studio svg[data-cts-glyph] { background: center / contain no-repeat; }
html.codex-theme-studio svg[data-cts-glyph="new-task"] { background-image: var(--cts-asset-icon-new-task); }
```
零布局位移。模型按钮靠文本正则标注（/sol|spark|codex|gpt/i）。

### 5. 品牌 Logo（工作区标题）

标题文本拆在多个 span——标注打在**整个 button**（textContent 聚合匹配，每轮 ensure 重算以支持工作区切换）。CSS 用 `.app-shell-left-panel [data-cts-logo]` 级 specificity 压过侧栏通用文字规则；`min-height: 56px` 给两行艺术字留高。

### 6. 选择器胶囊（素材化小胶囊三连修）

```css
/* 底：9-slice 胶囊素材挂 ::before（不吃按钮内容盒） */
html.codex-theme-studio main button:has([class*="_dropdownLabel"]) {
  position: relative !important; isolation: isolate; background: none !important;
  border: 0 !important; overflow: visible !important;   /* ①原生 overflow:hidden 会把素材裁成圆角形 */
}
html.codex-theme-studio main button:has([class*="_dropdownLabel"])::before {
  content: ""; position: absolute; inset: -4px -9px; z-index: -1; pointer-events: none;
  border-style: solid; border-width: 15px 18px;
  border-image: var(--cts-asset-pill-cream) 103 124 fill stretch;
}
/* ②文字：placeholder 态 49.8% 半透明、选中名 span 无 class——后代通配 + 强制不透明 */
html.codex-theme-studio main button:has([class*="_dropdownLabel"]),
html.codex-theme-studio main button:has([class*="_dropdownLabel"]) * {
  color: #2a2a28 !important; opacity: 1 !important;
  -webkit-text-fill-color: #2a2a28 !important;   /* ③绘制期优先于一切 color 规则的终极武器 */
}
/* ④第二层裁剪：水平滚动行容器也会裁探出素材——padding 腾挪（裁剪发生在 padding box 边界） */
html.codex-theme-studio [class*="horizontal-scroll-fade-mask"]:has([class*="_dropdownLabel"]) {
  padding: 8px 14px !important; margin: -8px -14px !important;
}
/* ⑤行的 z-0 祖先困住它在 deck 边框之下——提升 context 创建者 */
html.codex-theme-studio div.z-0:has([class*="_dropdownLabel"]) { z-index: 12 !important; }
```
**素材组件的深浅哲学**：米白金属胶囊是"物理道具"，刻字永远深色 ink——实体按钮不因房间变暗而改印字色。素材组件天然免深浅两套；只有纯 CSS 面板才需要 `[data-cts-shell]` 分支。

### 7. 发送按钮（标志性道具）

按钮保持**原生盒**（改盒尺寸/负 margin 必撑破 footer 行 → composer 出现滚动）；道具画在 **wrapper 的 ::after**（滚动容器之外，探出不产生滚动区），状态用 `:has()` 中继：
```css
html.codex-theme-studio div:has(> .composer-surface-chrome)::after {
  content: ""; position: absolute; right: 2px; bottom: 2px; width: 46px; height: 46px;
  z-index: 11; pointer-events: none;
  background: var(--cts-asset-spark-lence) center / contain no-repeat; transform: rotate(-24deg);
}
html.codex-theme-studio div:has(.composer-surface-chrome button[class*="size-token-button-composer"]:hover)::after { /* 焰光+转正 */ }
html.codex-theme-studio div:has(... button:disabled)::after { background-image: var(--cts-asset-spark-lence-closed); }
```
双态素材（开壳=可发送/收拢=禁用）是最出彩的叙事细节。
**默认安全范围是 42-54px**，悬停 scale 建议 ≤1.10。`pointer-events:none` 只保证不拦点击，不能证明视觉上没有遮住相邻按钮；80px 盒即使不制造滚动，也很容易盖住模型、审批或附件控件。

**细长形道具**（枪/杖/插入栓）存在感偏弱时，优先在素材层收紧透明 bbox、调整素材内部角度、增强亮度/描边/阴影；不要先放大 CSS 盒。确需超过 54px 时必须同时满足：

1. 目标 composer 宽度的窄态与宽态都截图；
2. 根据 wrapper rect + `::after` computed width/height/right/bottom 推导道具矩形；
3. 与同一行所有可交互按钮 rect 做相交检测，交集必须为 0；
4. hover/disabled 两态重复检测。

发送按钮的原生盒不可改尺寸、margin 或布局位置；只调整 wrapper 伪元素的视觉素材。

### 8. 浮层与全局兜底

浮层四件套统一面板化（米白/深色随 shell）+ `[data-highlighted]` 高亮；tooltip 深底时内部文字要强制浅色（原生 ink token 会把深字穿进来）。首页锁滚动：
```css
html.codex-theme-studio main.main-surface.cts-home-shell [class*="container-type"] { overflow-y: hidden !important; }
```
（quick-chat 缓存 DOM 会把首页撑出几千 px 滚动；deck 下框探出视口的 5px 也会被计成滚动区。）

### 9. 开屏动画

runtime 在 `previous?.stamp !== STAMP` 时创建 `#cts-intro`（fixed z2147483000, pointer-events none），2.3s 后 JS remove；播放前检查 `prefers-reduced-motion` 与素材变量存在。**素材登记约定 key `"intro"`**（runtime 检查 `--cts-asset-intro`，兼容旧名 tiga-punch）——别用主题私有名，否则动画静默不播。
**动画语汇必须是该 IP 自己的启动仪式**，别复用前作编排：迪迦=变身（conic 放射光旋转+人物 scale 冲镜头+白闪）；EVA=弹射发进（竖直速度线雨下移+机体自底部 translateY 急冲急停 squash+十字光闪）。设计前先问"这个 IP 的出场仪式是什么"。
CSS 速度线技法：`radial-gradient(2px 44px at 50% 50%, 色, transparent 72%) 0 0 / 9px 130px repeat` 椭圆光斑 tile（两方向都有透明段=短划雨，三层错相更自然）；**linear-gradient tile 横向无间隙会连成横带**（180deg 条带方向与直觉相反，实测踩坑）。

## 四、深色变体（`[data-cts-shell="dark"]` 块集中放文件末尾）

- runtime 自动在 html 上标注 `data-cts-shell="dark|light"`，跟随 Codex 外观实时切换。
- 需要 override 的只有**纯 CSS 绘制面**：body/main/设置页的 veil 换深蓝黑、台面换深金属渐变、hero 文字低亮度光晕、浮层/消息卡暗底浅字、滚动条琥珀化。素材组件（deck/胶囊/卡片/Logo）不动。
- **body veil 必须与 main veil 完全同色阶**，且 main 的 box-shadow 深色下去掉——否则 header 区出现深灰带与分割线。
- sticky 保护条深色版必须**渐变到全透明**（实底会在 main 顶部形成黑带）。
- 浅灰线稿水印深色下隐形——换 `-dark` 白线变体素材。

## 五、五条铁律

1. **闪烁纪律**：ensure() 每次 mutation 后运行——同值重写 style/class/attr 也会脏化样式状态引发整页闪烁。一切写操作先读比较；route 检测粘滞（portal 挂载不得翻转主题类）；MutationObserver 过滤自己装饰层内的变化；chrome 定位 rect 缓存。验证：探针统计主题相关 mutation，连跑 ensure×20 + portal 挂卸×5 计数必须 0。
2. **滚动纪律**：absolute 元素（含伪元素、哪怕 pointer-events none）探出 overflow:auto 祖先边界就产生滚动区。装饰放大件一律挂滚动容器**之外**的 wrapper。验收标准：`composer.scrollWidth-clientWidth===0 && scrollHeight-clientHeight===0`、首页可滚容器数 0。
3. **裁剪纪律**：素材探出会被三层东西裁——元素自身 overflow/圆角、水平滚动行容器、更外层 auto 容器。逐层排查：放 visible → padding 腾挪 → 挂到更外层。
4. **层叠纪律**：原生 `div.relative.z-0` 类祖先困住子元素 z-index——提升必须作用在**创建 context 的那层**（`:has()` 定位）；该层自带背景一并透明化。
5. **文字纪律**：主题深底上强制浅字、素材浅底上强制深字，用后代通配 + `opacity:1` + `-webkit-text-fill-color`（终极武器）三件套；凡带标签限定的选择器要自查复用 class（aside/div、main/div 三案例）。
6. **还原纪律**：off 后验收到属性级零残留——`[data-cts-glyph]/[data-cts-icon]/[data-cts-logo]` 计数必须 0（runtime cleanup 已内置清理，但 verify 时要数）。

## 六、调试方法论

1. **图不显示** → CDP 查 computed style：值在不在？在→查加载（fetch data URL、Image onload、2MB 限）；不在→查选择器/规则进没进 style。
2. **规则在但没效果** → 三查：被裁剪（祖先 overflow）？被盖（stacking context，用 elementsFromPoint + 祖先链枚举 position/z-index/opacity/transform/isolation）？被更高优先级覆盖（同 !important 比 specificity 与出现顺序）？
3. **页面永远旧样式** → stamp 没变（指纹要 hash 打包产物）或守护进程旧代码（stop+start）。
4. **对照实验二分**：同样式挂 body 下测试 div（z9999）——好→问题在层叠/裁剪；坏→问题在资源/语法。
5. **凡"消失/异常"先做原生对照**：`off` → 查 → `use` 恢复，30 秒定性是主题 bug 还是应用自身状态（项目选择器一案：原生态同样不存在）。
6. **hit-test 盲区**：`elementsFromPoint` 探不到 pointer-events:none 的层，也探不到**伪元素**——视觉遮挡要用逐层隐藏法二分（注入临时 style 逐个 display:none 对照截图）。
7. **活体原子采集**：迭代期用户可能同时在用这个 app（开关侧栏、hover、切外观、换路由），布局随时变——截图与 DOM 量化必须同一时刻做（同一条 evaluate 里），拿旧截图坐标对新 DOM 必然破案失败；historical 截图只当线索不当证据。用户的物理鼠标也是状态源（hover 态会一直挂着）。
8. **外观切换的程序化路径**：菜单栏快捷键（Cmd+,）走主进程，渲染器 CDP 打不到；可靠路径=CDP `Input.dispatchMouseEvent` 真实坐标点击（React 组件常忽略合成 click()）：点用户头像→设置→外观卡。theme.json 的 appearanceTheme 由 CLI 写 config.toml（quit 后有 ~2s 回写竞态窗口，CLI 已内置缓冲）。
9. **截图状态门槛**：`verify pass` 不等于截到了要验收的页面。开屏动画可能覆盖整屏，建议卡也可能因路由或产品状态根本未挂载。截图前原子断言：`#cts-intro` 不存在、目标路由类存在、目标组件数量符合预期；组件缺失时截图只能证明“注入活着”，不能证明该组件布局正确。
10. **optical size 不是 DOM size**：四个 button rect 完全相同仍可能出现三小一大。对透明位图额外读取 alpha/opaque-core bbox，按最终渲染盒生成 contact sheet；DOM 几何与素材 optical bbox 两套证据必须同时通过。
