# DSH 群聊插件 · 最终方案（v1）

> 代号：`dsh-group-chat`　包名：`@local/dsh-group-chat`　位置：`D:\tools\dsh-group-chat`
> 目标 DSH：`0.2.2-rc.3`（Windows / Web GUI）
> 状态：方案定稿，等待逐阶段实施

---

## 1. 要解决什么

一个聊天框里坐着来自不同渠道的 AI，各自保留自己的模型、登录、工具链和会话历史；用户能点名发言、能让它们互相看结论，也能把「已经在 Codex / Claude Code 里跑过的那条会话」直接拉进来继续。

**不做**：不做多模型投票、不做自动无限辩论、不做跨机器协同。

---

## 2. 关键事实（已实测，决定架构）

| 事实 | 证据 | 影响 |
|---|---|---|
| 官方 `subagent_codex` / `subagent_claude_code` 是**一次性**的 | 工具描述 `This backend does not accept follow-up messages`；config 无 thread id 参数 | **不能**用它们做常驻群成员，必须自建适配器 |
| Codex 支持续接会话 | `codex exec resume <id>` / `--last` / `fork` | 可「真接管」已有 Codex 会话 |
| Claude Code 支持续接会话 | `claude -p --resume <session-id>` / `--continue` / `--fork-session` | 可「真接管」已有 Claude 会话 |
| 两者都能流式 JSON | `codex exec --json`、`claude --output-format stream-json` | 可逐 token/逐事件回传 |
| Codex 会话在磁盘可枚举 | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | 「复制 AI 过来」的选择器有数据源 |
| Claude 会话在磁盘可枚举 | `~/.claude/projects/**/*.jsonl` | 同上 |
| DSH 禁止插件追加新 session event 类型 | `references/practices.md` 第 21 条 | **群聊不能内联进 chat 流**，必须有独立渲染面 |
| 客户端可注册 keyed chat node | `conversation.chat.node` 槽 | 需要新 kind 才能内联；v1 不用，v2 再评估 |

**由此确定的两个硬决策**

- **D1 群聊不塞进 chat 流**，用独立面板（悬浮层）。规避 session event 约束，且不干扰主对话。
- **D2 外部成员靠自建进程适配器**，不用官方一次性 provider。

---

## 3. 用户可见形态

```
┌─ DSH 会话（主对话） ────────────────────────┐
│  ...                                        │
│  ┌────────────────────────────────────────┐ │
│  │ 〔输入框〕            [群聊 ▸]  2        │ │  ← composer.dock 按钮（带未读角标）
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
         │ 点击
         ▼
┌─ 群聊面板（悬浮层） ─────────────────────────┐
│ 群：服装后端架构组 ▾      [+ 新建群]         │
│ ┌ 成员 ───────────────────────────────────┐ │
│ │ ◆ 架构师  codex    gpt-6-astra   在线  │ │
│ │ ◆ 实现    claude   deepseek-v4   在线  │ │
│ │ ◆ 审校    dsh      deepseek-flash 在线  │ │
│ │ [+ 添加成员]  [↧ 从已有会话导入]        │ │
│ └─────────────────────────────────────────┘ │
│ ┌ 消息流 ─────────────────────────────────┐ │
│ │ 你: 订单状态机怎么拆？                  │ │
│ │ ◆架构师(codex): 建议三段式……            │ │
│ │ ◆审校(dsh): 同意，但缺回滚路径           │ │
│ └─────────────────────────────────────────┘ │
│ 〔 @架构师 @审校  说点什么… 〕      [发送]   │
└─────────────────────────────────────────────┘
```

- `@成员` 指定发言；`@全体` 串行依次发言。
- 未点名时默认只发送给你（不触发模型），避免误烧额度。
- 面板可折叠、可拖动、位置记忆。

---

## 4. 架构

```
┌─────────────── Client（浏览器）────────────────┐
│ client.js                                      │
│  ├ GroupDockButton   → conversation.composer.dock
│  └ GroupPanel(悬浮层 React) ← 每 1.2s 轮询 API  │
└───────────────────┬────────────────────────────┘
                    │ fetch /group-chat/api/*
┌───────────────────┴─── Host（Node）────────────┐
│ index.js                                        │
│  ├ RouteTable     → ctx.webServer.register      │
│  ├ GroupStore     → $DSH_HOME/storages/group-chat/
│  ├ Orchestrator   → 串行队列 + 超时 + 取消      │
│  ├ ChannelAdapter                               │
│  │   ├ dsh    → ctx.llm.stream（纯对话成员）     │
│  │   ├ codex  → spawn codex exec --json         │
│  │   └ claude → spawn claude -p --output-format │
│  └ ToolSet → ctx.tools.register（模型可调用）   │
└─────────────────────────────────────────────────┘
```

### 4.1 为什么不把 `dsh` 成员做成 in-process agent（v1）

带工具的 in-process agent 会继承权限、预算和沙箱语义，出错面大。v1 让 `dsh` 成员走 `ctx.llm.stream()` **纯对话**，模型/推理档位可配；v2 再评估升级为 `ctx.agentLoop.createAgent`。

### 4.2 数据模型（文件落在 `$DSH_HOME/storages/group-chat/`）

`groups.json`
```json
{
  "version": 1,
  "groups": [{
    "id": "g_20261116_ab12",
    "name": "服装后端架构组",
    "cwd": "D:\\project\\ApparelWin_Backend",
    "createdAt": "2026-11-16T13:00:00+08:00",
    "members": [{
      "id": "m_arch",
      "name": "架构师",
      "role": "负责系统设计与取舍，回答只给结论和理由",
      "channel": "codex",
      "model": "gpt-6-astra",
      "permissionMode": "never",
      "threadId": null,
      "importedFrom": null,
      "status": "idle"
    }]
  }]
}
```

`transcripts/<groupId>.jsonl`：每行一条
```json
{"seq":7,"at":"...","memberId":"m_arch","author":"架构师","channel":"codex","kind":"message","text":"...","usage":{"in":1200,"out":340},"ms":18300}
```
`kind`: `message` | `note`（系统提示）| `error` | `tool`（成员调用了工具，可选）

### 4.3 群上下文怎么喂给成员

每轮只发**增量 + 摘要**，不是全量 transcript：

```
[角色] <member.role>
[群规] 这是多人讨论。你只代表你自己的角色；不要复述别人的话；结论先行。
[背景] <group.brief 可选，十行以内>            ← 「已否决方案」写这里
[近期] 最近 N 条（默认 12 条，按字符上限 6000 截断，旧的用 "…省略 k 条…" 标记）
[本轮] <@你的这条消息>
```

- 超出上限时触发一次轻量摘要（用 `ctx.llm` 生成 10 行），写回 `group.brief`。v1 先只做截断，v1.1 再做摘要。

### 4.4 通道适配器契约

```ts
interface ChannelAdapter {
  readonly channel: 'dsh' | 'codex' | 'claude'
  /** 可否接管已有会话 */
  readonly supportsImport: boolean
  /** 列出可导入的已有会话 */
  listSessions(limit: number): Promise<ImportableSession[]>
  /** 发起一轮 */
  say(req: SayRequest, onEvent: (e: SayEvent) => void): Promise<SayResult>
}
```
`SayEvent`: `{ type: 'delta', text }` | `{ type: 'thread', threadId }` | `{ type: 'usage', usage }` | `{ type: 'error', message }`

**codex 适配器**
- 命令：`<codexBin> exec --json --skip-git-repo-check [--resume <threadId>] [--sandbox <mode>]`
- 首轮无 `--resume`；从事件流里抓 `thread_id`（字段名 P1 阶段用真实样本确认）
- 进程 cwd = `group.cwd`；超时默认 10 分钟；取消 = kill 进程树
- 可执行文件解析顺序：配置项 → `PATH` 的 `codex` → 已安装的 `@openai/codex-win32-x64` 内置二进制

**claude 适配器**
- 命令：`claude -p --output-format stream-json --verbose [--resume <sessionId>]`
- Windows 上走 `claude.cmd`（`.ps1` shim 不能直接 spawn）
- 抓 `session_id` 存为 `threadId`
- `permissionMode` 映射：`dontAsk` / `acceptEdits` / `plan` / `bypassPermissions`

**dsh 适配器**
- `ctx.llm.stream({ provider, model, messages })`，无工具，无沙箱

### 4.5 模型可调用的工具（让我在聊天里能操作群）

| 工具 | 作用 |
|---|---|
| `group_create` | 建群（name, cwd?, brief?） |
| `group_list` | 列群与成员 |
| `group_add_member` | 加成员（channel, name, role, model?, threadId?, mode?） |
| `group_say` | 发言人（`@id` 或 `all`），返回各成员回复 |
| `group_transcript` | 读最近消息（limit/since） |
| `group_sessions` | 列出可导入的已有 codex/claude 会话 |
| `group_export` | 导出 Markdown 纪要到群目录 |
| `group_delete` | 删除群与聊天记录 |

工具返回保持**有界**：只回摘要 + `seq`，全文靠 `group_transcript` 取。

### 4.6 HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/group-chat/api/state` | 群、成员 |
| POST | `/group-chat/api/groups` | 建群 |
| POST | `/group-chat/api/groups/:id/say` | 发言，**202 立即返回**，结果走 transcript 轮询 |
| GET | `/group-chat/api/groups/:id/status` | 该群是否有进行中的发言 |
| GET | `/group-chat/api/groups/:id/transcript?since=` | 增量消息 |
| POST | `/group-chat/api/groups/:id/members` | 加成员 |
| POST | `/group-chat/api/groups/:id/cancel` | 取消进行中的发言 |
| GET | `/group-chat/api/groups/:id/export` | 导出 Markdown 纪要 |
| POST | `/group-chat/api/groups/:id/delete` | 删群 |
| GET | `/group-chat/api/sessions?channel=` | 可导入会话 |

鉴权：裸 handler 拿不到 peer，因此用双通道——插件往 index HTML 注入一次性 token（前端以 `x-group-chat-token` 回传），或同源判定（`Origin` 结尾匹配 `Host` / `sec-fetch-site: same-origin`）。外部进程缺凭据一律 403。

---

### 4.7 可配置项（写进 profile 的 `cordis.patch.yml`）

```yaml
- id: dsh-group-chat
  name: "@local/dsh-group-chat"
  config:
    maxParallelMembers: 2      # 每轮同时发言的成员数，默认 1，上限 8
    dailyTokenBudget: 1000000  # 每群每日 token 上限，0 = 不限
    timeoutMs: 600000          # 单成员超时
    codexModel: gpt-6-astra    # 未指定 model 的 Codex 成员默认值
    claudeModel: null          # 同上，Claude
```

### 4.8 流式能力边界（实测）

| 渠道 | 能流式吗 | 依据 |
|---|---|---|
| `claude` | ✅ 真 token | `--include-partial-messages` → `stream_event/content_block_delta`，实测 9 个 `text_delta` |
| `dsh` | ✅ 真 token | `ctx.llm.stream()` 的 `text-delta` 分片 |
| `codex` | ❌ 做不到 | `codex exec --json` 只有 `item.completed/agent_message`，整段一次给齐；要流式得改用 `app-server` 协议 |

Codex 成员在面板上显示为「思考中 + 已用秒数」，不伪装成逐字输出。

### 4.9 群聊模板

`group_create` 的 `template` 参数直接装配名册：

| 模板 | 成员 |
|---|---|
| `dev` | 架构师(codex) + 实现(claude) + 审校(dsh) |
| `review` | 主审(claude) + 复核(dsh) |
| `research` | 调研(dsh) + 收敛(codex) |

## 5. 分期与验收标准

### P0 脚手架（本次）
- 产出：`package.json` / `cordis.patch.yml` / `locale/{en,zh}.json` / `icon.svg` / `docs/DETAIL.md` / `index.js`（空 apply）/ `client.js`（dock 按钮 + 空面板）
- 验收：`install_bundle` 返回 `application: applied`；插件页出现「群聊」条目与图标；会话输入框下出现按钮，点击弹出空面板。
- 失败退路：`remove_bundle` 回滚。

### P1 Host 内核 + 两个外部通道（可在聊天里跑通）
- 内容：GroupStore、Orchestrator、codex/claude 适配器、`group_*` 工具
- 验收（脚本化，不靠肉眼）：
  1. `group_create` 后 `groups.json` 落盘正确；
  2. `group_add_member(channel=codex)` 后 `group_say` 能拿到真实回复，且 `threadId` 被持久化；
  3. 第二次 `group_say` 走 `--resume`，成员能引用上一轮内容（**这一条是关键验收**）；
  4. `channel=claude` 同上；
  5. 取消与超时：`cancel` 后进程树被杀，transcript 记 `error/取消`。
- 失败退路：只保留 `dsh` 通道，外部通道标 `unavailable` 并给出原因。

### P2 HTTP + 客户端面板
- 验收：面板能建群、加成员、发消息、看到流式回复；刷新页面后状态保持；未读角标正确。
- 失败退路：面板降级为只读（能看到 transcript，不能发）。

### P3 「复制 AI 过来」
- 内容：`listSessions` 两个通道；面板里「从已有会话导入」选择器；`threadId` 直填 → 首轮即 `resume`
- 验收：导入一条 2026-11 之前的真实 Codex 会话，问它「我们上次聊到哪」，回答能引用该会话内容。
- 失败退路：退化为「摘要移植」模式（只抽前 N 轮做 brief）。

### P4 打磨
- 流式 token 显示、并发上限、成本统计（codex 用订阅额度、deepseek 按 token 估算）、导出会议纪要 Markdown、群规模板。

---

## 6. 风险清单（按咬人概率排序）

| 风险 | 触发 | 处置 |
|---|---|---|
| **Codex 的 `--json` 事件结构随版本变** | 升级 codex | P1 先用真实样本固化成 fixture，解析失败降级为纯文本 + 只取最后一段 |
| **Windows 进程树杀不干净** | 取消/超时 | `taskkill /T /F` + 记录 pid，启动时清理孤儿 |
| **只 spawn `.ps1` shim 失败** | claude | 走 `.cmd` 或 `node <js>`；启动时探测可执行文件 |
| **并发写同一仓库** | 两成员同时改文件 | 群级串行锁（默认 1），并发需显式配置；建议配合 worktree |
| **额度被烧** | @全体 / 自动讨论 | 默认不自动触发；`@全体` 需显式；每群每日 token 上限 |
| **长会话撑爆上下文** | 多轮 | 截断 + 摘要；单成员上下文上限可配 |
| **插件面板挡住主界面** | 悬浮层 | 默认折叠、位置记忆、Esc 关闭、点击外部关闭 |
| **认证/越权** | HTTP 路由 | owner-only，按 peer 校验；不暴露到非本机会话 |

---

## 7. 文件布局

```
D:\tools\dsh-group-chat\
├─ package.json
├─ cordis.patch.yml
├─ index.js              # Host：路由、存储、编排、工具、适配器调度
├─ client.js             # Client：dock 按钮 + 悬浮面板
├─ lib\
│   ├─ store.js          # 群/成员/transcript 持久化
│   ├─ orchestrator.js   # 串行队列、超时、取消
│   ├─ channels\
│   │   ├─ codex.js
│   │   ├─ claude.js
│   │   └─ dsh.js
│   ├─ prompt.js         # 上下文拼装与截断
│   └─ tools.js          # group_* 工具定义
├─ locale\{en,zh}.json
├─ icon.svg
└─ docs\DETAIL.md
```

---

## 8. 回滚

- 插件级：`plugin_manager remove_bundle`（或插件页关闭）
- 数据级：删除 `$DSH_HOME/storages/group-chat/` 即清空所有群，不影响 DSH 会话
- 进程级：无后台常驻进程，每次发言是独立子进程，插件卸载即停
