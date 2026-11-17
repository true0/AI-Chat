# dsh-group-chat

把 **Codex、Claude Code、DeepSeek Harness** 拉进同一个群聊房间：一个话题、多个 AI 各自发言、`@` 点名、接管已有会话继续聊。

它是 DeepSeek Harness（DSH）的右栏 tab 插件，装进 profile 后与「文件 / 终端 / 浏览器」并列。

![群聊面板](docs/ui-after.png)

## 它解决什么

多个 AI 工具各管一段工作，会话分散在不同 CLI 里，人在中间手工搬运上下文。这个插件把它们的会话拉进同一个房间，共享一段群背景，按需点名，各自保留自己的登录、会话与沙箱。

## 能力

| 分类 | 能力 |
|---|---|
| 成员渠道 | `codex`（子进程 + `codex exec --json`）、`claude`（子进程 + `--output-format stream-json`）、`dsh`（当前 Harness 的模型服务，最省钱） |
| 会话接管 | 成员可绑定已有会话 id：`fork`（分叉，读得到上下文、不改原历史）或 `resume`（续写原线程）；`dsh` 为只读导入，只把历史当上下文，不写回 |
| 面板形态 | 右侧栏 tab，两栏（群列表 248px + 内容区），宽度 < 520px 自动切成列表 ⇄ 内容切换式 |
| 群管理 | 建群（名称 + 模板 + 多个项目目录）、重命名、移除（归档保留，可恢复）、群搜索、未读角标 |
| 模板 | `dev`（架构师 codex + 实现 claude + 审校 dsh）、`review`（主审 claude + 复核 dsh）、`research`（调研 dsh + 收敛 codex） |
| 发言 | 发全体或按成员定向、`@` 弹出成员列表（↑↓ / Enter / Esc）、异步受理（`POST /say` 立即 202）、停止回复、回到底部提示 |
| 显示 | Claude / DSH 流式增量，Codex 显示「思考中 + 计时」（`--json` 只在结束时给整段）；消息头像、作者行、同人合并、错误块 |
| 成本 | `group_usage` 与面板标题栏统计 tokens / 估算 USD；`dailyTokenBudget` 超限在花钱前拒绝 |
| 并发 | `maxParallelMembers`（默认 1，上限 8）有界 worker pool |
| 导出 | 一键导出 Markdown 纪要（成员表、背景、逐条发言与耗时） |
| Agent 工具 | 12 个 `group_*` 工具，AI 也能直接建群、拉人、发言、导出 |
| HTTP | `GET /state`、`POST /groups`、`/say`、`/status`、`/cancel`、`/usage`、`/transcript`、`/export`、`/rename`、`/remove`、`/sessions`、`/archive`、`/archive/:id/restore` |

## 安装

插件以本地目录形式安装，不需要构建（ESM，无打包步骤）。

1. 把本目录放到本机任意位置，例如 `D:\tools\dsh-group-chat`。
2. 在 DSH 里安装：**插件 → 添加插件 → 选择这个目录**；或让 DSH 里的 agent 执行 `plugin_manager` 的 `install_bundle`，`target` 传该目录的绝对路径。
3. 安装结果应为 `application: applied`。刷新页面（`Ctrl+R`），右侧栏出现「群聊」tab；输入框下方的「群聊」按钮也能打开。

**运行前提**：DSH 桌面版（或 `dsh` CLI）。`codex`、`claude` 两个渠道需要对应的 CLI 已安装并各自登录；只用 `dsh` 渠道则无需任何外部依赖。

## 配置

在 profile 中该插件的 `config` 行里设置：

| 键 | 默认 | 说明 |
|---|---|---|
| `maxParallelMembers` | `1` | 同一群并发发言上限，1–8；默认串行，避免多个成员同时改同一份代码 |
| `dailyTokenBudget` | `1000000` | 每日 token 额度，`0` 为不限；超限在调用前拒绝 |
| `timeoutMs` | `600000` | 单个成员单次发言超时 |
| `codexBin` / `claudeBin` | 自动探测 | 自定义 CLI 路径 |
| `codexModel` / `claudeModel` | 渠道默认 | 默认模型 |

## 工程结构

| 路径 | 作用 |
|---|---|
| `index.js` | Host 入口：`tools` / `webServer` / `workingDirectory` / `llm` 注入，注册工具、HTTP 路由、token 注入 |
| `lib/ops.js` | 业务核心：建群、加成员、发言编排、并发池、额度、导出 |
| `lib/store.js` | 落盘存储：`$DSH_HOME/storages/group-chat/`（`groups.json`、`transcripts/*.jsonl`、`archive/`） |
| `lib/channels.js` | codex / claude 子进程驱动与流式解析 |
| `lib/dsh.js` | 读取 DSH 自己的会话（projcache + 多帧 zstd 解压）作为只读上下文 |
| `lib/sessions.js` | 三个渠道的历史会话枚举 |
| `lib/http.js` | HTTP 路由与同源校验 |
| `lib/tools.js` | 12 个 `group_*` 工具定义 |
| `client.js` | 客户端面板（右侧栏 tab、建群/加成员弹窗、`@` 提及、流式渲染） |
| `cordis.patch.yml` | 装载补丁：插入 `dsh-group-chat` 行 |

## 已知限制

- **Codex 单次约 120 秒**：`wss://chatgpt.com` 被拒后重试 5 次才回落 HTTPS。开代理有改善，彻底解法是改用 `codex app-server` 长连接。
- **Codex 写锁**：目标会话正被 Codex 桌面端打开时 `resume` 会失败，插件会提示改用 `fork`。
- **Claude 会话按项目目录存放**：跨 cwd 接管可能 `No conversation found`。
- **归档目录只能手动清理**：面板还没有「彻底删除归档」入口；无快照的早期归档不可恢复。
- **群消息只存在插件自己的存储里**，不写入 DSH 会话日志；外部成员是独立子进程，不继承 Harness 的工具权限。
- **客户端改动后必须换版本号重装**：DSH 页面会缓存旧 bundle，仅 toggle 插件不足以让页面拿到新代码。

## 文档

- [`docs/PLAN.md`](docs/PLAN.md) — 方案与分期
- [`docs/PROGRESS.md`](docs/PROGRESS.md) — P0–P14 逐阶段实施与验收证据
- [`docs/DETAIL.md`](docs/DETAIL.md) — 插件说明
- [`docs/prototype-interactive.html`](docs/prototype-interactive.html) — 可交互原型（双击打开）
