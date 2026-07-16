# 素材生产手册（gpt-image-2-skill 全流程 + 实测参数）

素材生成与抠图**只用 gpt-image-2-skill**：

```bash
# 必须用函数形式——zsh 默认不做变量词分割，GIS="node xx.cjs --json" 再 $GIS 会报
# "no such file or directory: node /path --json"（把整串当一个命令名）。
GIS() { node "$HOME/.claude/skills/gpt-image-2-skill/scripts/gpt_image_2_skill.cjs" --json "$@"; }
GIS config inspect   # 先看实际 provider 与 runtime，不从旧项目脚本猜配置。
GIS doctor
GIS auth inspect     # OpenAI key / compatible base / Codex auth 任一 ready 即可。
```

风格锁定素材优先用 `images edit --ref-image <概念图>`，`--quality high`，`--format png`。全局参数必须放在命令组之前：`GIS --provider auto images edit ...`，不要写成 `GIS images edit --provider ...`（旧版 CLI 会报 `unexpected argument`）。

**禁止无限并发**。默认最多同时 4 个远端生成任务；每项必须有独立日志、JSON Events 和超时，结束后逐项检查退出码与目标文件，不能只写一个裸 `wait`。批量任务中，零字节日志且长时间无 `request_completed` 应视为挂起，不是“继续耐心等待”。

## 素材类型学（一套完整主题 ≈ 35-40 项）

以迪迦主题为范例，一套皮肤的素材分 8 类。规划阶段照此开清单：

| 类 | 迪迦主题的实例 | 数量 | 规格 | 用法 |
|---|---|---|---|---|
| 墙面/氛围背景 | 米白控制台墙（含网格细线） | 1 | 2560x1440 前后 | main/body 背景 cover；深浅共用一张 |
| 立绘 | 迪迦半身像 | 1 | 竖版 1344x2016 | `::before` 右下锚定 contain，clamp() 尺寸 |
| 输入台 deck | 格栅宽版 + 对称窄版（对话页） | 2 | 1440x480（3:1 上限） | 9-slice 边框（无 fill），输入区底色 CSS 画 |
| 卡片屏 | 雷达/节点图/波形/战舰线框 ×4 | 4 | 1024x736 | 每张卡不同屏幕内容，比通用黑屏还原度高 |
| icon 集 | 神光棒/彩色计时器/水晶/战机… | 16 | 1024x1024→256 | 覆盖侧栏 6 + 卡片 4 + 输入栏 3 + 搜索/设置/文件夹 |
| 品牌 Logo | CODEX / ChatGPT WORK 特摄艺术字 | 2 | 1440x736 | 替换工作区标题（唯一允许带文字的素材） |
| 标志性道具 | 神光棒开壳/收拢双态 | 2 | 1024x1024 | 发送按钮的常态/禁用态——叙事细节的关键 |
| 小件 | 翼章、线稿水印（浅+白双色）、胶囊底 | 3-4 | 1024 级 | 水印、侧栏印花、选择器胶囊 9-slice |

尺寸约束：宽高均为 **16 的倍数**、最大边 3840、总像素 ≤8294400、宽高比 ≤3:1、**最小 65 万像素**（512x512 会被 CLI 拒绝，icon 用 1024）。

两条实测教训：
- **provider 会把非标尺寸回落到模型固定档位**（请求 2560x1440 可能实得 1536x1024）——背景大图 cover 放大可接受，但要有心理预期。
- **同一组多张素材（如四张建议卡）必须比例一致**：各卡生成构图不同 → bbox 裁剪后比例参差（0.97~1.52 都有），`background-size: 100%/100%` 各自变形不一，用户一眼看出"第 N 张大小不对"。做法：生成时把画布比例锁成渲染盒比例（如卡片 218x128 → 生成 1440x848），bezel 厚度也在 prompt 里锁死（"THIN uniform bezel of EQUAL thickness on all four sides"）；比例跑偏就重生成，不要用 CSS 修补。

生成后必须用 Pillow 读取**实际像素尺寸**并与请求值记录在同一份 manifest；provider 回落不可静默。成组素材在抠图后还要以最终 CSS 渲染尺寸做 contact sheet，检查的是可见主体/装甲边框的 optical size，不是文件画布尺寸。

## 远端失败降级（不要重复撞同一堵墙）

`images edit` 对“大参考图 → 竖版单人物”可能连续返回 HTTP 500，且一次请求可挂数分钟。降级顺序固定为：

1. 同一请求最多容许 CLI 自带重试一次完整结束；超过任务超时立即终止。
2. 将参考图裁到目标主体附近，降低输入复杂度，再 edit 一次。
3. 若仍为 5xx，而任务允许不带 reference，则改走 `transparent generate`，直接得到已抠图并自验收的 PNG。
4. 若 reference fidelity 是硬要求，则停止并报告失败，不要偷偷用 prompt-only 结果冒充风格锁定产物。

每次降级都要记录原始错误、使用的路径和 fidelity 变化；禁止连续四轮提交完全相同的失败请求。

## Prompt 模板库（实测通过）

**通用规则**：英文写 prompt；结尾必带 `NO text, NO letters, NO numbers anywhere.`（Logo 素材除外）；透明底素材生成在 **perfectly flat pure magenta background** 上并留边距。

**① 空舞台背景**（关键：KEEP/REMOVE 清单 + 留空声明）：
> Using this UI concept art as the exact style reference, repaint it as an EMPTY STAGE version: <材质氛围> filling the ENTIRE canvas edge to edge. KEEP: <立绘/纹理/装饰清单>. REMOVE COMPLETELY: the sidebar, all cards, the input deck, the title bar, and ALL text. The removed areas must be filled with the same <材质> continuing seamlessly. No text anywhere. Clean, high detail, product-render quality.

**② 透明底部件**（deck/卡/徽章/胶囊）：
> Close-up product render of <部件>, isolated and centered on a perfectly flat pure magenta background: <材质结构细节>. Straight-on front view, no perspective tilt, soft even studio lighting. NO text... Flat pure magenta background with clear margin.

**③ 带屏幕内容的卡片**（每张一种图形）：
> ... ON THE DARK SCREEN FACE: <radar scope / node-link network / waveform / isometric wireframe>, thin sci-fi linework. NO text ...

**④ icon 集**（统一风格批量）：
> A small flat vector-style badge icon of <奥特曼语汇描述>, bold simple shapes in 3-4 colors (silver, gold, red, cyan-blue) with subtle metallic sheen, clean thick outlines readable at small size, centered with large margin on flat pure magenta. NO text.

**⑤ 特摄标题 Logo**（唯一带文字的素材；短英文单词可靠）：
> Japanese tokusatsu TV series title logo artwork reading exactly <WORD>: bold three-dimensional metallic letters with beveled chrome edges, <红金/蓝银> gradient faces, starburst glint, slight italic lean, dramatic 1990s Ultraman title-card style, on flat pure magenta, large margin. The logo must read <WORD>.

**⑥ IP 道具（重要教训——文字描述外观会连败）**：
1. 首选：用户提供实物照片 → `--ref-image 照片` + "Recreate the exact prop from this reference photo faithfully, preserving every design detail"（迪迦神光棒最终就是这么成的，还顺手生成了开壳/收拢双态）。
2. 次选：直接报道具名让模型凭自身知识画（"The Spark Lens (スパークレンス) from Ultraman Tiga, official replica, product photo"），并发 2-3 个措辞版本挑最像的。
3. 禁忌：自己发明外观描述（"银柄金翼红宝石头"三连败）。

**⑦ 修图迭代**：以上一版产物为 `--ref-image`，"Edit this image: remove/replace <目标>, keep everything else identical."

## 抠图 → alpha 归一化 → 严格验证 → optical bbox → 入库

Skill 已附带 `scripts/normalize_alpha.py` 与 `scripts/asset_contact_sheet.py`。优先直接调用脚本；下面的 Pillow 代码保留为算法说明和无法定位 Skill 目录时的备用实现。

```bash
# 1. chroma 抠图。JSON 单独保存，后面要读取实际采样到的 matte 色。
GIS transparent extract --method chroma --input gen.png --matte-color auto \
  --profile icon --out alpha.png > extract.json

# 2. alpha 归一化：去低 alpha 杂点、scrub 透明 RGB、裁主体、补透明边距。
python3 "$HOME/.claude/skills/codex-theme-maker/scripts/normalize_alpha.py" \
  alpha.png --alpha-floor 16 --padding 16

# 等价算法：
python3 - <<'PY'
from PIL import Image

def normalize_alpha(path, alpha_floor=16, padding=16):
    img = Image.open(path).convert("RGBA")
    alpha = img.getchannel("A").point(lambda a: 0 if a < alpha_floor else a)
    img.putalpha(alpha)
    mask = alpha.point(lambda a: 255 if a else 0)
    img = Image.composite(img, Image.new("RGBA", img.size, (0,0,0,0)), mask)
    bbox = img.getbbox()
    if not bbox: raise RuntimeError(f"empty alpha: {path}")
    img = img.crop(bbox)
    out = Image.new("RGBA", (img.width + padding*2, img.height + padding*2), (0,0,0,0))
    out.paste(img, (padding, padding))
    out.save(path, "PNG")

normalize_alpha("alpha.png")
PY

# 3. 严格复验。必须回传 extract 自动采样的 matte，不能接受
#    matte_residue_checked=false 的“看起来通过”。
MATTE=$(python3 -c 'import json; print(json.load(open("extract.json"))["extraction"]["matte_color"])')
GIS transparent verify --input alpha.png --profile icon \
  --expected-matte-color "$MATTE" --strict > verify.json

# 4. 按 optical bbox 裁成最终 WebP。阈值按角色分组固定，不逐张拍脑袋：
#    柔光/人物 60-75；硬边 icon/deck 85-90；带半透明外阴影的卡片可用 120。
python3 - <<'PY'
from PIL import Image

def to_webp(src, dst, optical_floor=85, margin=5, square=False, maxsize=None):
    img = Image.open(src).convert("RGBA")
    alpha = img.getchannel("A")
    bbox = alpha.point(lambda a: 255 if a >= optical_floor else 0).getbbox()
    if not bbox: raise RuntimeError(f"empty optical bbox: {src}")
    l,t,r,b = bbox
    img = img.crop((max(0,l-margin), max(0,t-margin), min(img.width,r+margin), min(img.height,b+margin)))
    if square:
        side=max(img.size); out=Image.new("RGBA",(side,side),(0,0,0,0))
        out.paste(img,((side-img.width)//2,(side-img.height)//2)); img=out
    if maxsize and max(img.size)>maxsize:
        img.thumbnail((maxsize,maxsize), Image.Resampling.LANCZOS)
    img.save(dst,"WEBP",quality=90,method=6)

to_webp("alpha.png", "asset.webp", optical_floor=85, square=True, maxsize=256)
PY

# 5. 全部 WebP quality 86-90。硬约束：单素材 base64 后 < 2MB
#    （Chromium URL 上限 2097152 字符，超限 data URL 被静默判无效——图直接消失无报错）
#    平滑大图压缩比极高（1.9MB PNG → 56KB WebP）。

# 6. 登记 theme.json 的 assets 映射（注入后可用 var(--cts-asset-<key>) 引用）
```

### profile 选择

| 资产结构 | 推荐 profile | 说明 |
|---|---|---|
| 单一主体 icon/道具 | `icon` / `product` | 第二组件通常应视为杂点 |
| 主体带多个小装饰 | `sticker` | 允许更多小组件，但不保证两个等大主体通过 |
| 两个或多个主要分体 | `seal` | 例如一对独立发夹、环+中心符号 |
| 非典型组合或仅需基础 alpha 门槛 | `generic` | 必须人工确认组件都是有意内容 |

不要为了“让验证变绿”盲目放宽 profile。先看 `component_count`、`largest_component_ratio`、`stray_pixel_count` 与素材语义；两个近似等大的组件不是 stray pixel。

### 成组卡片的两类尺寸问题

- **构图/比例本身不一致**：装甲框厚度、透视、屏幕比例不同——重生成，不能 CSS 拉伸。
- **构图一致但透明阴影范围不同**：低 alpha 阴影把 bbox 撑大，可见装甲只占画布 85%/90%——用同一 `optical_floor` 重新裁切，再做目标尺寸 contact sheet。不要为每张卡分别写 `background-size: 118% 113%` 之类补丁。

```bash
python3 "$HOME/.claude/skills/codex-theme-maker/scripts/asset_contact_sheet.py" \
  themes/<id>/assets/card-*.webp \
  --output /tmp/cards-sheet.jpg --cell 338x256 \
  --optical-floor 120 --fit stretch
```

`--cell` 必须来自实机 DOM 的 button rect；`--fit` 必须与 CSS 的 `background-size` 行为一致。

## 9-slice 参数测量（deck/胶囊类素材必做）

素材裁剪后跑此脚本得到 slice 与 border-width（**必须在最终裁剪版上测**）：

```python
from PIL import Image
img = Image.open("asset.webp").convert("RGBA"); px = img.load(); w, h = img.size
def dark(x, y):
    r, g, b, a = px[x, y]
    return a > 200 and r < 75 and g < 75 and b < 85   # 深色屏幕区判定，按素材调
y_mid = h // 2; runs, start = [], None
for x in range(w):
    if dark(x, y_mid):
        if start is None: start = x
    else:
        if start is not None: runs.append((start, x-1)); start = None
if start is not None: runs.append((start, w-1))
x0, x1 = max(runs, key=lambda r: r[1]-r[0])
ys = [y for y in range(h) if dark((x0+x1)//2, y)]; y0, y1 = min(ys), max(ys)
print(f"slice(TRBL): {y0} {w-x1} {h-y1} {x0}")
print(f"border-width = slice × (目标屏幕区高 ÷ {y1-y0})")   # 例：composer 高 98px → ×98/(y1-y0)
```

## 特殊变体素材

- **深色模式水印**：浅灰线稿在深底隐形——PIL 把非透明像素改成 `(232,229,218,α)` 生成 `-dark` 变体，深色背景层引用它。
- **屏幕区纯色化**：deck 类素材若屏幕区有光影渐变，9-slice 拉伸会产生断层——最佳做法是 9-slice 去 fill、屏幕区颜色交给 CSS（见 css-recipes 输入区配方）；素材只保留边框。

## 质量门槛（每张素材过检后才入库）

- `transparent verify --strict` 的 `passed: true`；`alpha_min=0`、`alpha_max=255`、`touches_edge=false`、`transparent_rgb_scrubbed=true`、`matte_residue_checked=true`、`failure_reasons=[]`。
- `matte_residue_score` < 0.05（超了目视复查品红/紫边）；透明素材至少保留 8-16px margin。
- 缩到实际渲染尺寸目视：细节可辨、边缘干净、无 AI 畸变。
- 风格与 optical size 统一性：拼图对照（同组素材按**最终渲染盒尺寸**排 sheet，不能只排等宽缩略图）。
- 命不中就重生成——第一批一次成型率高的秘诀是 prompt 里写死材质词与照明词（同一套形容词贯穿所有素材）。
