# Codex 版本兼容策略

皮肤运行时采用“已审计版本档案 + DOM 能力探测”，不会仅凭版本号硬编码一套 DOM。
版本档案负责收紧验收条件；实际注入始终从当前 renderer 识别 Composer shell、可选 lane
和有限高度 editor，避免同一版本因页面状态不同而走错分支。

| Codex 版本 | 构建号 | Composer 档案 | lane 规则 | 审计状态 |
| --- | ---: | --- | --- | --- |
| `26.715.31251` | 5538 | `composer-three-layer` | 多行时必须存在，且 `overflow-y: visible`；单行时不要求 | 真实 App 验证通过 |
| `26.715.31925` | 5551 | `composer-two-or-three-layer` | 可选；存在时必须为 `visible` | 真实 App 验证通过 |
| 其他版本 | — | `capability-adaptive` | 按实时 DOM 探测 | 标记为未审计 |

两个已审计版本都要求 shell 为 `overflow-y: clip`。多行布局的有限高度 editor 必须为
`overflow-y: auto`；单行布局不伪造滚动 editor。运行时优先从 `[data-codex-composer]`
反查主输入框，避免把 PR 评论卡等复用 `.composer-surface-chrome` 的静态表面当成验收对象。
这能保留多行输入滚动，同时避免皮肤的 Composer 装饰把整个输入框变成滚动容器。

每次 Codex 更新后应先比对镜像仓库的 Delta，再运行两类回归：

1. 旧版与新版真实 App 分别注入、验证并截图；
2. 独立浏览器夹具覆盖三层、两层、重复 `ensure()` 和热切换。

确认新版本后，再把它加入 `verifyExpression()` 的已审计档案。未登记版本可以继续用能力探测
试运行，但验证结果会保留 `audited: false`，不会冒充已完成版本验收。
