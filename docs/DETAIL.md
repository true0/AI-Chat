# 群聊（Group chat）

把来自不同渠道的 AI 成员拉进同一个面板，点名发言，共享一段群上下文。

## 现状

已交付为右侧栏 tab（`group-chat`，与文件 / 终端 / 浏览器并列），Host 侧 12 个 `group_*` 工具与 HTTP 接口齐全，客户端面板为两栏形态。

分期实施与逐项验收证据见 [`PROGRESS.md`](PROGRESS.md)（P0 脚手架 → P14 多项目目录），方案见 [`PLAN.md`](PLAN.md)。

## 成员通道

| 通道 | 说明 |
|---|---|
| `codex` | 子进程驱动 `codex exec --json`，可 `--resume` 续接原生会话 |
| `claude` | 子进程驱动 `claude -p --output-format stream-json`，可 `--resume` |
| `dsh` | 走当前 Harness 的模型服务，纯对话成员 |

## 限制

- 群消息只存在插件自己的存储里（`$DSH_HOME/storages/group-chat/`），不写入 DSH 会话日志。
- 外部成员是独立子进程，不继承 Harness 的工具权限；它们用自己的沙箱与登录。
- 同一群默认串行发言，避免多个成员同时改同一份代码。
