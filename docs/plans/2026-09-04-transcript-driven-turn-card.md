# 转写驱动的回合卡片、配额展示与单人会话精简信封

> 状态：探索记录 + 落地状态。原「转写驱动回合卡」方案已被用户否决，最终按下方「落地状态」实施。基于 2026-09-04 master `86e99a3c` 的代码探索。
> 目标 CLI 先做 claude-code，数据模型对 codex 保持同构。

## 0. 三个诉求与现状的差距

| 诉求 | 现状 | 差距 |
| --- | --- | --- |
| 卡片里按顺序看到本轮每条 assistant 消息、工具调用与思考，后两者默认折叠 | 流式卡正文是终端截图或隐藏；工具调用/思考只进飞书原生「思考气泡」（`message_cot`）；最终回复靠模型手写 `botmux send` | 转写里的结构化事件已解析成 `CotEntry[]`，但没进卡片；assistant 文本块没进 `CotEntry` |
| 实时看到上下文大小、5h 配额、重置时间 | claude-code 只从转写算出上下文绝对值（无窗口、无百分比），没有任何配额概念 | Claude Code statusline JSON 现成提供 `context_window.used_percentage` 与 `rate_limits.five_hour/seven_day`，仓库零引用 |
| 单人私聊/单人群不要逐轮注入，回复不走 `botmux send`，直接展示完整上下文 | 逐轮注入 `<botmux_reminder>` + `<sender/>` + `<user_message>` 壳；系统提示要求必须 `botmux send`；没有按会话形态收窄的 gate | 转写 fallback 已能在模型不 send 时自动转发最终回复；缺「单人会话」谓词与「转写回复模式」开关 |

## 1. 事实基础（探索结论，附代码位置）

### 1.1 回复卡正文来源

- 主路径：模型执行 `botmux send "<markdown>"`，`src/cli.ts:9861-9979` → `md-card.ts:792 buildCardBodyElements` → `createReplyCard`。
- 兜底路径：模型本轮没 send，worker 从转写取 `trailingAssistantText`（`src/services/claude-transcript.ts:426`）→ `final_output` IPC → `worker-pool.ts:14752 buildCanonicalFinalReplyCard`。抑制规则见 `src/services/bridge-fallback-gate.ts`，投递带重试与 uuid 去重（`worker-pool.ts:14235-14288`）。
- 终端截图只进流式状态卡（`card-builder.ts:876-905 pushStreamBody`），10s 一帧（`worker.ts:8423`）。
- codex-app 先例：runner 系统提示明说「最终 assistant 消息由 botmux 自动转发到 Lark，不要为普通回复调用 botmux send」（`src/codex-app-runner.ts:310-312`）。

### 1.2 结构化事件已存在

- `extractCotEntries`（`claude-transcript.ts:377-396`）按 content block 顺序产出 `thinking | tool_call | tool_result`，**跳过了 `text` 块**。
- codex 同构：`codex-transcript.ts:281 codexCotEntriesFromResponseItem`。
- worker `observeCotEntries`（`worker.ts:4306`）累积全量列表，1.5s trailing 节流，上限 60K 字符，经 `thinking_update` IPC 到 daemon；唯一消费者是 `cot-message.ts`（原生气泡）。
- 卡片 PATCH 已有串行化 + latest-wins（`worker-pool.ts:3648-3720 scheduleCardPatch`）与 per-app 15 QPS 网关（`api-gate.ts`）。

### 1.3 本机转写实测（claude-code 2.1.260）

- Opus 5 / Fable 5 的 `thinking` 块内容为空串，只有 `signature`（1405+446 个块，0 个非空）。**thinking 折叠面板对这两个模型没有内容可展示**；codex 的 reasoning summary 有内容。
- 一条 DM 会话 351 轮，57 次 `botmux send`；每轮实际收到：`<botmux_reminder>…</botmux_reminder>` + `<user_message>…</user_message>` + `<sender type="user" open_id=… name=… />`，偶尔带 `<botmux_skills_refresh>`。

### 1.4 Claude Code statusline（官方文档 https://code.claude.com/docs/en/statusline.md）

- stdin JSON 含 `context_window.{context_window_size, used_percentage, total_input_tokens, current_usage}`、`rate_limits.{five_hour,seven_day}.{used_percentage, resets_at(Unix 秒)}`、`session_id`、`transcript_path`、`model`。
- 触发：每条 assistant 消息后、`/compact` 后、到达 `resets_at` 时、可选 `refreshInterval` 秒；300ms 防抖。
- 可经 `--settings` 进程级注入；botmux 已用同一通道注入 inline settings（`claude-code.ts:859-881`）。
- 本机 `~/.claude/statusline-command.sh` 已在读这些字段并把 `rate_limits` 写到 `/tmp/flux-rl.json`（当前 5h 已用 18%）。settings.json 只允许一个 `statusLine`，需要链式转发避免覆盖用户自己的状态栏。

### 1.5 飞书卡片规格（官方文档）

- `collapsible_panel`：`expanded` 默认 false，`elements` 可放 markdown，不能放 form；容器最多嵌套五层。
- 整卡硬上限 30KB（错误码 200860）、200 个元素（300305）；`im.v1 messages patch` 单条消息 5 QPS。
- CardKit 流式：单卡 10 次/秒，流式期间豁免 QPS，10 分钟自动关闭，期间不可转发；`sequence` 全卡严格递增。
- 折叠面板内容 `im.message.get` 读不回来（`message-parser.ts:1085 CARD_EMBEDDED_PLACEHOLDER`）：`/quote`、话题上下文回读会看到占位符。

## 2. 落地状态（2026-09-05，分支 feat/transcript-reply-mode）

用户补充后方案收窄：过程展示留在飞书原生思考气泡而不新建卡片；配额只要百分比；最终回复
单独成卡、流式卡标「已完成」。三条工作流各一个提交，默认配置下行为逐字节不变：

| 提交 | 工作流 | 内容 |
| --- | --- | --- |
| `e0effcda` feat(session) | W2 | `replyDelivery: 'send' \| 'transcript'`：转写 fallback 升为主通道；不注入每轮 `<botmux_reminder>`；solo 会话（p2p / 仅 owner 的 1v1 群）裸文本信封；最终回复卡投递后流式卡标「已完成」；`/botconfig`、dashboard、bots-json 文档。后续调整：claude-code 默认 transcript，提示中不再出现 botmux send（显式 `send` 才退回旧行为） |
| `bc577b64` feat(cot) | W3 | `CotEntry.tool_call.subject` 在 args 截断前提取（`services/cot-subject.ts` 共享）；bot 级 `thinkingCardToolResult` 开关（默认 on） |
| `60ae6467` feat(card) | W1 | `botmux statusline` 子命令 + 进程级 `--settings` 注入（refreshInterval 60s，链式转发用户自己的 statusline）；卡片用量段 `ctx 23% · 5h 18% · 7d 5%` |

未做 / 后续：
- 原稿 W3「转写驱动回合卡」（CardKit 流式 + 折叠面板）整体搁置；若将来要做，第 1 节的
  数据流与规格约束仍然有效。
- `cli-usage-limit.ts` 用 statusline 真实 `resets_at` 替换正则刮「resets 10:40pm」（可选）。
- 空闲期配额刷新定时器（当前只在 working 期间与状态边沿刷新）。
- 上游遗留：`envelopeInjection` 在 `loadBotConfigs` 里没有被解析（重启即丢），本次未改。
