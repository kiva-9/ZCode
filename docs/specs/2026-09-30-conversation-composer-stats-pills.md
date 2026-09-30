# 会话窗口计量模块（StatsPills）移植 Spec

- 日期：2026-09-30
- 状态：已实现
- 参考：DSH 开源仓库（github.com/deepseek-ai/deepseek-harness）`packages/client/ui-chat/src/client/chat/StatsPills.tsx`。本 spec 记录 ZCode 侧的行为、数据来源与相对 DSH 的取舍。

## 1. 行为概述

在 V4 会话窗口 composer 下方新增计量行（ZCode 首个 DSH StatsPills 移植件）：

- **时间 pill**（gauge 图标）：`{轮}轮 {步}步 · {速度} tok/s`，点击弹出「会话统计」面板（轮次 / 模型步数 / 输出速度）。
- **用量 pill**（database 图标）：`{总量} tok · 缓存命中 {百分比}%`，点击弹出「Token 用量」面板（缓存命中、未缓存输入、缓存读取、缓存写入、输出）。
- 原有「上下文窗口计量」（`ChatContextUsage`）从工具条行**下移**到计量行下方一行，展示与交互不变。
- 两个 pill 互斥打开（一个开则另一个关）；点击外部 / Esc 关闭。

## 2. 数据与状态所有者

单一所有者 = CLI `ProductProjection`（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`）在 v4 快照上维护 `stats`；UI 只读投影，不自行累计。

`snapshot.stats`（新增 additive 字段，`packages/shared/src/zcode-protocol-v4/snapshot.ts`）——8 字段与 DSH `SessionStatsProjection` 逐字对齐，全部由 CLI 事件流折叠（非 UI 近似）：

| 字段          | 语义                                                                 |
| ------------- | -------------------------------------------------------------------- |
| `turns`       | userInput 来源且非 controlOnly 的 product turn 数（DSH: turns）        |
| `steps`       | 主轮 ModelComplete 次数（DSH: steps / step-end）                    |
| `llmMs`       | 主轮模型请求墙钟求和（model_request → model_complete）                |
| `toolMs`      | 主轮工具用时求和（tool_call_result.duration；error 用 Started 配对）  |
| `ttftMs`      | 主轮首 token 延迟求和（model_request → 首个 model_streaming）         |
| `ttftSteps`   | 记录了首 token 的步数                                               |
| `decodeMs`    | 主轮解码用时求和（首个 model_streaming → model_complete）            |
| `decodeTokens`| 同 decodeMs 步的输出 token 求和                                      |

- `turns`：`onTurnStarted` 中 `fact.turnHeaderOrigin === "userInput" && fact.executionKind !== "controlOnly"` 时 +1。compact/goal continuation/workflowLaunch 等维护轮不计。
- `steps`/各计时：与既有 `usage.cumulative` 同一 ModelComplete 累计点、同一主轮门禁（`isMainTurn`），state.updated 与 usage 同一补丁原子下发；`toolMs` 在工具终态补丁内下发。
- 恢复语义与 `usage.cumulative` 一致（hydration 重放事件流重建折叠）；无独立持久化/种子路径。

用量 pill 的四个分桶直接读既有 `snapshot.usage.cumulative`（inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens），不新增计数。

## 3. 相对 DSH 的取舍（验收时按 ZCode 语义核对）

1. **数据管线完整移植**：`snapshot.stats` 8 字段与 DSH `SessionStatsProjection` 逐字对齐，由 CLI `ProductProjection` 折叠同一事件流：`llmMs` = model_request → model_complete；`ttftMs/ttftSteps` = model_request → 首个 model_streaming；`decodeMs/decodeTokens` = 首个 model_streaming → model_complete；`toolMs` = tool_call_result.duration（权威值），tool_call_error 不带 duration 时用 ToolCallStarted 配对补。侧车请求（标题/压缩/子代理/workflow_child）按 querySource 门禁排除，与 DSH「只数主会话可见步」一致。旧事件日志缺 model_request/model_streaming 时计时为零 → 速度不显示，计数仍正确。
2. **统计口径**：DSH 的 `deriveStats` 是「可见窗口折叠」兜底；ZCode 直接读耐久 `snapshot.stats`，不做窗口折叠（v4 尾部窗口仅 60 行，折叠会少计，故不做）。
3. **缓存命中百分比**：移植 DSH `formatCacheHitPercent` 的取整逻辑——补到「不再四舍五入到 100」的最小精度（99.9 / 99.99…），全命中显示 100，无计费输入返回 null（pill 隐藏该项）。
4. **对话框与原版对齐**：时间 pill 有计时数据时可点开「会话统计」（模型用时 / 工具调用用时 / 首 token 平均 / 输出速度），无任何计时数据时退化为纯展示 span（DSH 同门禁，不开空面板）；用量 pill 点开「Token 用量」（缓存命中 + 四桶精确计数）。
5. 图标用 lucide（`Gauge`/`Database`）替代 DSH primitives；样式用 DESIGN.md token（`text-ui-sm text-foreground-subtle`、`bg-hover`、`rounded-full` pill、`bg-popover` 面板、`tabular-nums`）。

## 4. UI 落点与交互

- `packages/ui/src/v4/chat/StatsPills.tsx`：纯展示组件，props 收 `stats`、`cumulative`；`sessionStatsFormat.ts` 承载全部纯计算（取整/门禁/速度/时长）。弹层用 Radix `Popover`（`side="top"`，视口钳制由 Radix 负责），排他打开状态在组件内。
- `packages/ui/src/v4/composer/V4ComposerUsageRow.tsx`：composer 输入框 surface 正下方的新行容器 = StatsPills 行 + 下移的 `ChatContextUsage` 行。 entitlement / coding plan / start plan 等 context usage 所需的 hooks 从 `V4ComposerToolbar` 整块搬迁到本组件（职责随行迁移，不复制两份）。
- `V4ComposerToolbar`：删除 `ChatContextUsage` 渲染及其独占 wiring（`useCodingPlanEntitlements`、`useUsageEntitlement` team access、`useSettings`、codingPlanUsageRemaining、contextStartPlanBalance、access 刷新等）；保留 `usage` prop（仍服务 `TID_V4_MODEL_CONFIG` 的 data-usage-* e2e 锚点）与 `onSendCompressionCommand` 改由新行组件接收。压缩按钮禁用条件由 `disabled || recoveryPending` 收敛为 `disabled`（recoveryPending 是工具条内部模型恢复态，发送门禁在宿主已覆盖）。
- e2e 锚点保持：`TID_CHAT_CONTEXT_USAGE_TRIGGER`、`TID_V4_MODEL_CONFIG`（含 data-usage-used/data-usage-max）。

## 5. 文案（i18n）

新增 key（zh-CN / en-US 对称）：

- `chat.stats.counts`：{turns}轮{steps}步 / {turns} turns {steps} steps
- `chat.stats.cacheHit`：缓存命中 {percent}% / Cache hit {percent}%
- `chat.stats.tokensPerSecond`：{tps} tok/s
- `chat.stats.tokenCount`：{count} tok
- `chat.stats.dialog.title`：会话统计 / Session statistics
- `chat.stats.dialog.llmTime`（模型用时 / LLM time）、`chat.stats.dialog.toolTime`（工具调用用时 / Tool time）、`chat.stats.dialog.ttft`（首 token 平均 / Avg first token）、`chat.stats.dialog.speed`（输出速度 / Output speed）
- `chat.stats.dialog.usageTitle`：Token 用量 / Token usage
- `chat.stats.dialog.cacheHit`、`chat.stats.dialog.input`、`chat.stats.dialog.cacheRead`、`chat.stats.dialog.cacheWrite`、`chat.stats.dialog.output`
- `chat.stats.duration.seconds`：{seconds}秒 / {seconds}s；`chat.stats.duration.minutes`：{minutes}分{seconds}秒 / {minutes}m{seconds}s

精确计数复用 `new Intl.NumberFormat(locale)`；紧凑数字复用 `@/lib/tokenNumberFormat` 的 `formatCompactTokenNumber`；速度数值格式移植 DSH（≥10 取整，<10 一位小数）。

## 6. 验收场景

| # | 场景                                             | 期望                                                              |
| - | ------------------------------------------------ | ----------------------------------------------------------------- |
| 1 | 新会话发送 2 轮、每轮含工具调用                   | 时间 pill 显示 2 轮 N 步；toolMs > 0；decodeMs > 0 时显示速度       |
| 2 | 观察进行中/已完成的会话 pill                     | 速度 = decodeTokens ÷ decodeMs（会话 decode 平均，随步数闭合刷新）   |
| 3 | 有用量累计的会话                                 | 用量 pill 显示 `总量 tok · 缓存命中 X%`；X <100 时不显示 100       |
| 4 | 无 token 活动（全部请求失败）                     | 两个 pill 均不渲染（与 DSH 的 hasTokens/steps 门禁一致）          |
| 5 | 点击时间 pill / 用量 pill                        | 弹出对应面板，两pill互斥；Esc / 点击外部关闭                      |
| 6 | 上下文计量位置                                   | 位于计量行下方；hover 面板内容与交互不变                          |
| 7 | 旧快照（无 stats 字段）解析                      | schema default 生效，pill 显示 0 轮 0 步                          |
| 8 | 冷恢复（进程重启后回到会话）                     | stats 由 hydration 事件重放聚出，与 usage.cumulative 同语义        |

## 7. 测试

- 纯计算层：`packages/ui/test/conversationStatsPills.test.ts`（node:test，已执行 11/11 通过）——缓存命中取整、总量口径、pill 门禁、decode 速度、紧凑时长。
- CLI 折叠（turns/steps/llmMs/toolMs/ttft/decode 累加、补丁原子性、侧车门禁）：本检出版未挂可运行单测入口（`packages/*/test` 下既有 node:test 文件在开源清理后已引用不存在的模块、无统一 runner），按要求如实记录为未覆盖，不谎报通过。
- shared：snapshot/delta 的 additive default 与 round-trip 由 typecheck 与既有 schema 测试路径覆盖。
