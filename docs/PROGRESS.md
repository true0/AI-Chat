# 实施进度

对照 `docs/PLAN.md` 的分期。每完成一个阶段就更新本文件。

## P0 · 脚手架 — ✅（2026-11-16）

`package.json` 含 `dsh.bundle.patch` + `dsh.client`；`install_bundle` → `application: applied`；客户端槽位 `conversation.composer.dock` 出现 `dsh-group-chat`。

## P1 · Host 内核 + 外部通道 — ✅（2026-11-16）

| 验收项 | 结果 |
|---|---|
| 建群并落盘 | ✅ `~/.dsh/storages/group-chat/` |
| Codex / Claude 成员 | ✅ 真实回复（123.6s / 7.6s） |
| **会话 id 持久化** | ✅ `hasThread: true` |
| **二轮续接且记得上文** | ✅ Codex 答出 `7412`；Claude 复述上一轮原话 |

## P2 · HTTP + 面板接线 — Host 侧 ✅（2026-11-16）

`401/403` 鉴权、`GET /state`、`POST /groups`、`POST /members`、`POST /say`、`GET /transcript` 全部实测通过；Claude 2.06s 返回 `OK`。

**踩坑**：prefix 路由不能带尾斜杠；`resource` 路由只支持 GET/HEAD 且不带 peer → 写操作必须用裸 `handler`。

## P3 · 三渠道 + 已有会话接管 — ✅（2026-11-16）

| 渠道 | 机制 | 验收 |
|---|---|---|
| `codex` | `exec --json` → `thread.started.thread_id` | ✅ 二轮 `7412` |
| `claude` | `-p --bare --output-format json` → `session_id` | ✅ 二轮复述；`--bare` 省 21 倍 token |
| `dsh` | `ctx.llm.stream()` 原生模型调用 | ✅ 997ms 答对群成员构成 |

| 接管能力 | 验收 |
|---|---|
| 枚举历史会话 `group_sessions` | ✅ 扫到 235 条 Codex + 412 条 Claude |
| **fork 接管（默认）** | ✅ 接管 2026-10-29 旧会话，答出 `BYDINERAL USD 7,539 / A012026101301` |
| resume 接管 | ✅ Claude 会话 id 未变即挂上原会话；Codex 会话若被占用会报 `active writer` |
| 面板「选已有」选择器 | ✅ 已实现，待浏览器实测 |

### 本轮修掉的 bug

**fork 反复分叉**：fork 首轮会返回新 thread id，但 `importMode` 仍是 fork，导致第二轮又 fork 出一条新线程。现在拿到新 id 后自动切成 `resume`。

### 已知限制

- Codex 写锁：若目标会话正被 Codex 桌面端打开，`resume` 会失败；插件给出提示并建议改用 `fork`。
- Claude 会话按项目目录存放，跨 cwd 接管可能 `No conversation found`（错误信息已加提示）。
- Codex 每次调用 ~120s：`wss://chatgpt.com` 被拒后重试 5 次才回落 HTTPS。

## P4 · 异步 / 取消 / 导出 / 删群 — ✅（2026-11-16）

| 能力 | 验收 |
|---|---|
| **异步发言** | `POST /say` → `202 {"accepted":true}`，**21ms** 返回（原先要挂 150 秒） |
| 运行状态 | `GET /groups/:id/status` → 立刻 `busy:true`，完成后 `busy:false` |
| 取消 | `POST /groups/:id/cancel` → `{"cancelled":true}`；记录写「已取消」，状态回到 idle |
| 导出纪要 | `group_export` / `GET .../export` → 落盘 `群聊纪要-<时间>.md`，含成员表、背景、逐条发言与耗时 |
| 删群 | `group_delete` → 同时删除 transcript 文件 |
| 面板取消按钮 | 「成员正在思考…」+ 取消，1.5s 轮询状态 |

**修掉的文案问题**：取消时原本报 `codex 退出码 aborted`，现在归一成「已取消」/「超时未返回」。

## P4 · 打磨（全补）— ✅（2026-11-16 第二轮）

| 能力 | 实现 | 验收 |
|---|---|---|
| **流式显示** | Claude 走 `--output-format stream-json --include-partial-messages` 解析 `text_delta`；DSH 走 `ctx.llm` text-delta；Codex **无增量**（实测 `--json` 只在结束时给整段），面板显示「思考中 + 计时」 | Claude 探针实测 9 个 `text_delta`；面板 live 文本在完成前已增长 |
| **成本统计** | `group_usage` 工具 + `GET /groups/:id/usage` + 面板标题栏；兼容历史 raw usage 与新的 `{in,out,costUsd}` | `totalCostUsd: 0.14878`、5 次调用、8794 tokens |
| **并发上限** | `maxParallelMembers`（默认 1，上限 8）有界 worker pool | 两个 dsh 成员**同时在线**，总耗时 1689ms |
| **每日额度上限** | `dailyTokenBudget`（默认 1,000,000，0=不限），超限在花钱前拒绝 | 临时设 1 → 报「今日已用 8794 tokens，超过上限 1」 |
| **群聊模板** | `dev` / `review` / `research` 三套名册，建群即装配 | `template=review` → 主审(claude) + 复核(dsh) |
| **未读角标 / 拖动 / 位置记忆** | 角标基于 `lastSeq` 与 localStorage 已读位；面板头部可拖动，位置存 localStorage | ✅ 服务端渲染验证（见下） |

### 面板的渲染级验证（不靠人眼）

用 react-dom/server 把 `client.js` 真渲染成 HTML：

- 关闭态：`<button>群聊</button>`，带主题 token 样式
- 打开态：3641 字符完整 HTML，含可拖动头部（`cursor:move`）、用量位、关闭按钮、建群输入行

**顺带抓到一个致命 bug**：`react-dom` 不可用时组件 `return null`，面板会**静默消失**。已改成 inline 兜底渲染。这个 bug 只有真渲染才能发现。

仍未验证的只有「视觉布局是否好看」这一层。

## P5 · 首次真机使用后的修复（2026-11-16）

用户第一次真机打开面板，暴露两类问题，均已处理。

### 功能 bug：接口 403，面板永远是空的

原鉴权依赖「注入 token」或「`sec-fetch-site: same-origin`」，在 Electron 里两者都不成立 → 每个请求 403。

**改为**：只拒绝**外来 Origin**。监听器本来就只绑 loopback，而浏览器对跨站请求必定携带 Origin 且不等于本机 Host。
实测：无 Origin GET → 200；同源 GET → 200；外来 Origin GET/POST → 403。

### UX：把 5 个状态压成了 2 个画面

按 DSH 的 UI 验收规范做了一次 UX 专项评审（子智能体），核心判断：**问题不是文案，是没有状态机**。

重写为 4 个互斥状态：`加载中（骨架）` / `失败（替换内容区）` / `无群（建群引导）` / `就绪（加载中→无成员引导→聊天）`。

| 评审问题 | 处理 |
|---|---|
| 失败被画成空状态；错误贴在最底部；重试必然再失败 | 失败升级为面板级：标题 + 人话 + 主按钮「刷新页面」 |
| 无群时可点「+ 成员」「发送」，点了**静默无反应** | 无群隐藏成员行；禁用项一律带原因；名字为空时「建群」禁用 |
| 建群表单常驻主位，和聊天抢注意力 | 有群时收进「+ 新建群」，点击才展开 |
| 发言失败丢草稿 | 成功受理后才清空；失败保留草稿与焦点 |
| 每 1.5s 强制滚到底，历史读不了 | 贴底才自动滚；上翻后出「有新消息 · 回到底部」 |
| 切群串数据（消息/点名/已读） | 切群 = 完整重置：清空消息→骨架→清点名→复位滚动 |
| 连点建群会建出两个 | 提交中禁用 + 文案「建群中…」 |
| 渠道下拉缺 dsh | 已补上；dsh 不支持「续接已有会话」并给出原因 |
| 无 hover / focus 反馈 | 注入局部 CSS：hover / focus-visible / disabled 三档 |
| 固定尺寸、可拖出屏幕 | `max-width/height` 限制 + 拖动夹在视口内 + 双击标题复位 |
| 单行输入写不了长消息 | 换成 textarea，Enter 发送 / Shift+Enter 换行 |
| 文案（空群/选已有/进行中…） | 全部按评审建议替换，去掉「令牌/接口/HTTP」这类内部词 |

## P6 · 改成右侧栏 tab 入口（2026-11-16）

先做过一版「贴右侧的全高停靠面板」，用户要求做成**真正的右栏 tab**，已实现。

### 摸到的真实 API（不是靠猜）

右栏 tab 的注册入口不在客户端服务目录里（目录只列了 8 个核心服务），是从 asar 文档与内置实现里挖出来的：

```js
// 1) 注册一个 tab 类型（静态声明，返回 disposer）
ctx.effect(() => ctx.sidebarRightTabs.register({
  id: '@local/dsh-group-chat',   // 唯一 id，同时是 body / title 的 key
  kind: 'group-chat',            // 页类型，没有 patterns
  priority: 'builtin',
  title: () => '群聊',
}))

// 2) 正文与标题分别注册到 keyed 槽，key = 上面的 id
ctx.slots.inject('sidebar.right.pane.tab', () =>
  ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, GroupPanel))
ctx.slots.inject('sidebar.right.pane.tab.title', () =>
  ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, GroupTabTitle))

// 3) 按 kind 打开（dock 按钮点击时）
ctx.sidebarRight.openTab('group-chat')
```

客户端 `inject` 相应改为 `['slots', 'sidebarRight', 'sidebarRightTabs']`。

### 验收（inspect 结果）

| 槽位 | 结果 |
|---|---|
| `sidebar.right.pane.tab` | 出现 occupant **`@local/dsh-group-chat`**（active），与 guide / documentpreview / terminal / files / browser / subagent / plan / deliverables / schedule 并列 |
| `conversation.composer.dock` | 仍保留 `dsh-group-chat` 启动按钮（active） |

两个槽位同时存在 ⇒ 插件激活成功、两个服务注入正确、tab 类型注册通过（否则后两个 slot 不会执行）。

### 形态变化

- 面板不再是浮层，而是右栏的一个 tab：与「文件 / 终端 / 浏览器」并列，占据右栏轨道，中间对话区会让位
- 右侧栏自带的关闭/浮动/全屏控件接管了面板外观
- 输入框下的「群聊」按钮保留，作用变为「打开/聚焦该 tab」，仍带未读角标

## P7 · 按原型重写面板（2026-11-16）

原型确认后，把 `client.js` 整体重写为原型定稿的形态。**后端接口一行未改。**

| 原型决策 | 落地实现 |
|---|---|
| 两栏：左群列表 / 右内容 | 右栏 tab 内 `grid-template-columns: 248px minmax(0,1fr)`；宽度 < 520px 自动切成「列表 ⇄ 内容」切换式（ResizeObserver 实测宽度） |
| 弹窗操作 | 新建群 / 加成员 / 移除群聊都是居中弹窗，`Esc` 与点遮罩关闭，打开即聚焦名称 |
| 自绘下拉 | 渠道、模板都用自绘 listbox（原生 `<option>` 在暗色下是系统白底） |
| 会话 ID 接管 | 弹窗里的「会话 ID（可选）」输入框；留空 = 新建会话；填了显示「分叉 / 续写」二选一，选择存 localStorage |
| 选已有会话 | 调 `GET /sessions?channel=`，点一条自动填 ID 并带出名称 |
| `@` 点名 | 输入 `@` 弹出成员列表，↑↓ 选择、Enter/Tab 确认、Esc 关闭，选中并入选送对象；与 chip 手选取并集，都没选则发给全体 |
| 成员 chip | 只显示名字 + 6px 渠道色点（已绑定会话的点带一圈细环），渠道信息在 tooltip |
| 消息头 | 保留渠道名与耗时：`Codex-架构师 codex · 123s` |
| 移除群聊 | 列表行常驻淡显 ✕ + 「⋯」菜单两项入口，都走确认弹窗 |

验证：`sidebar.right.pane.tab` 的 occupant 出现 `@local/dsh-group-chat`（active），说明重写后注册链完好；`node --check` 通过。

## P8 · 归档与恢复（2026-11-16）

原来的「移除群聊」是**真删**（unlink transcript 文件）。按要求改成**归档保留**，并补齐恢复能力。

| 能力 | 实现 |
|---|---|
| 移除群聊 | 群从 `groups.json` 移除，transcript **改名移入** `archive/<群id>.jsonl`；`archive/index.json` 记录群名、目录、成员数、消息数、移除时间、文件名，以及**完整快照**（含每个成员的 threadId） |
| `group_remove` | 工具（原 `group_delete` 改名），返回值里带归档路径与「记录未删除」说明 |
| `group_archives` | 列出归档记录，带 `restorable` 标记 |
| `group_restore` | transcript 挪回 `transcripts/`，快照写回 `groups.json`，成员与已绑定的会话 id 原样恢复 |
| HTTP | `POST /groups/:id/remove`、`GET /archive`、`POST /archive/:id/restore` |
| 面板 | 左栏底部「N 个群 · 已移除 M」→ 打开归档弹窗，每行显示「N 人 · M 条 · 移除于日期」+「恢复」按钮 |

### 实测（移除 → 归档 → 恢复 → 上下文仍在）

1. 建「恢复测试群」→ 加 dsh 成员 → 发「记住暗号：蓝色海豚」
2. `group_remove` → `{"messages":2,"transcript":"...\\archive\\g_....jsonl","note":"聊天记录保留..."}`
3. `group_archives` → `{..., "restorable": true}`
4. `group_restore` → `{"restored":true,"group":{...,"members":1}}`
5. `group_transcript` → 2 条记录完好
6. 再问「暗号是什么」→ **答出「蓝色海豚」**，说明恢复后上下文仍可用

测试数据已清理，`archive/` 目录只会在真正移除群时产生内容。

## P9 · 视觉重构（2026-11-16）

按 UI/UX 评审（子智能体）给的规格整体重做样式，并搭了一个**真组件预览台**（加载 `client.js` + mock fetch + 无头 Edge 截图）用于自己迭代。

核心结论采纳：「问题不在配色，而在**没有层级**——所有内容贴在同一个平面，靠 1px 线和蓝色分区」。三条规则：**用底色分层、用对比度分层、一个焦点色（≤3%）**。

| 改动 | 具体 |
|---|---|
| 底色分层 | 左栏凹陷（黑 12%）、右栏头/成员条/输入区工具带（currentColor 3%）、浮层用 `--dsw-alias-bg-elevated`；结构线从 12% 降到 6%，全屏只剩 2 条 |
| 去掉线框感 | 按钮 / chip / 输入 / 下拉全部改为**填充式无描边**（原来 8 类控件都是"透明底 + 1px 描边"） |
| 字号与对比 | 13 / 12 / 11.5 / 11 四档，层级靠对比度（90 / 62 / 44 / 36%）承担，不再靠加粗 |
| 消息条目 | 加 28px 字母块（取名字里第一个汉字：Codex-架构师 → **架**、Claude-审校 → **审**、P1 验收群 → **验**）+ 作者行 + 正文 34px 缩进 + **同人连续消息合并**；自己的消息改为填充块、无头像 |
| 蓝色收敛 | 只有发送按钮是实心蓝；选中 chip 用中性底 + 1px 蓝环；未读药丸 12% 蓝底 + 蓝字（原来是 5 处完整强调） |
| 输入区 | textarea 40px 起、发送按钮 56×76 → 32px；提示行并入 11/36% |
| 浅色安全 | 灰阶全部改 `color-mix(in srgb, currentColor N%, transparent)`，不再写死半透明白；浮层不再硬编码 `#2a2a31` |
| 细节 | 细滚动条、按钮 hover 只变底色、danger hover 用 12% 红底、`prefers` 无关的极简阴影（只有浮层有） |

### 顺带修掉的两个真 bug

1. **窄模式空白**：`.gc-root.narrow .gc-list{display:none}` 把列表和内容同时藏了，`<520px` 打开就是一片空白。已改为默认显示列表、进入内容页才隐藏列表。
2. **根节点宽度被内容撑开**：补 `width:100%`，避免父容器是 flex 时只占 248px。

改前/改后：`docs/ui-before.png`、`docs/ui-after.png`、`docs/ui-after-narrow.png`。

## P10 · 与原型对齐（2026-11-16）

逐项比对 `docs/prototype-interactive.html`，补齐两处原型有、插件缺的东西：

| 缺项 | 落地 |
|---|---|
| **重命名群** | `store.renameGroup` + ops + 工具 `group_rename` + `POST /groups/:id/rename` + 面板「⋯ → 重命名」弹窗（Enter 保存） |
| **列表行「最近发言」** | `store.lastEntry`（只读 transcript 尾部 8KB，不扫全量）+ `listState().groups[].last`，列表第二行变成 `N 人 · 名字 耗时` |

实测：`group_rename` 改名成功并在 `group_list` 中回显，随后已改回原名。

### 与原型的功能对齐表

| 原型能力 | 插件状态 |
|---|---|
| 两栏 + 窄宽度切换 | ✅ |
| 群搜索 / 未读药丸 / hover 移除 | ✅ |
| 新建群弹窗（名称 + 模板自绘下拉） | ✅ |
| 加成员弹窗（渠道 / 名称 / 职责 / 会话 ID / 选已有 / 分叉·续写） | ✅ |
| `@` 提及 + 定向发送 | ✅ |
| 消息头像 / 作者行 / 同人合并 / 流式 / 错误块 | ✅ |
| 回到底部提示 / 停止回复 | ✅ |
| ⋯ 菜单：导出纪要 / 重命名 / 移除群聊 | ✅ |
| 移除确认弹窗 | ✅ |
| 已移除外加：归档列表 + 恢复 | ✅（原型没有，额外实现） |

## P11 · 修重叠（2026-11-16）

用户真机反馈：消息区压在输入框上、返回箭头压在标题行。

**根因 1（底部重叠）**：宿主的 tab 容器只给到 **auto 高度**，所以 `.gc-root` 的 `height:100%` 与 `grid-template-rows:minmax(0,1fr)` 都退化成"内容高度"——面板跟着消息一起长高，footer 与消息区自然叠在一起。

**最终修法**：不再依赖父容器。组件在挂载时量自己的 `getBoundingClientRect().top`，把根节点高度直接设成 `window.innerHeight - top - 4`，并在窗口 resize 与每 2 秒校准一次；这样无论宿主给的是确定高度还是 auto 高度，面板都是一个固定高度、内部滚动的区域。同时保留 `grid-template-rows:minmax(0,1fr)` 作为有确定高度时的兜底。

**验证方式**：预览台新增「auto 高度宿主」模式（`?auto=1`）复现真实容器行为，715×1100 灌 24 条消息 → 面板贴合视口、消息内部滚动、输入框固定，无重叠。

**根因 2（返回箭头）**：返回按钮的显隐用的是**内联 style**（`display: narrow ? ... : none`），一旦 `narrow` 状态和 CSS 判断不一致就会在宽屏下露出来。
→ 改成 CSS 控制：`.gc-root:not(.narrow) .gc-back{display:none}`，状态与渲染不可能再打架。

**复现与验证**：用预览台在 715×1100 下灌 24 条消息（长记录）复现了原来的溢出；修复后消息在容器内滚动、footer 固定、宽屏不出现返回箭头。

另：真机上出现旧问题也可能是**客户端包被缓存**（Electron 会话不会自动丢弃旧模块），已提示用户用 `Ctrl+Shift+R` 硬刷新。

## P12 · 布局修复确认（2026-11-16）

用户确认修复生效。根因有两条，缺一不可：

1. **`box-sizing` 缺失**（真 bug）：`.gc-input` 是 `padding:0 10px` + `width:100%`，默认 `content-box` 下实际宽度 = 100% + 20px → 搜索框越过分隔线。已在插件作用域补 `box-sizing:border-box`（`.gc-root *`、`.gc-dlg *`）。
2. **客户端包没换**：只改文件 + toggle 插件，页面仍加载旧 bundle（证据：返回箭头在宽屏下还在，而该现象早已由 CSS 规则消除）。**修法：改 `package.json` 版本号后 `remove_bundle` + `install_bundle` 强制换一代**。

### 这条应该记住

> 客户端代码改动后，**只 reload 插件不足以保证页面拿到新代码**；必须换版本号并重装，或用硬刷新验证。判断是否拿到新包的最快方式：找一个本轮刚改过的可见行为（例如返回箭头的显隐），它不对就是旧包。

验证方式：预览台模拟 `auto 高度宿主 + 56px 顶部偏移 + 24 条长记录`，面板高度 = `窗口 − top − 4`、消息内滚、输入框固定、搜索框不溢出、宽屏无返回箭头。

## 交付状态

| 面 | 内容 |
|---|---|
| 渠道 | `codex`（子进程，可 resume/fork 接管）、`claude`（`--bare`，省 21× token）、`dsh`（原生 llm，最省钱） |
| 工具（12） | `group_create` `list` `add_member` `say` `transcript` `sessions` `usage` `export` `rename` `remove` `archives` `restore` |
| HTTP | state / archive / groups / say(202) / status / usage / transcript / members / cancel / export / remove / rename / sessions / archive restore |
| UI | 右栏 tab（两栏、搜索、未读、流式、`@` 点名、停止、回到底部、弹窗、窄宽度切换） |
| 配置 | `maxParallelMembers`、`dailyTokenBudget`、`timeoutMs`、`codexModel`、`claudeModel` |

### 已知遗留

- Codex 每次调用约 120 秒：`wss://chatgpt.com` 被拒后重试 5 次才回落 HTTPS。开代理或有解；彻底解法是改用 `codex app-server` 长连接。
- 归档目录只能手动清理，面板里还没有「彻底删除归档」入口。
- 归档恢复依赖归档记录里的 `snapshot`；更早（无快照）的归档标记为不可恢复。

## P13 · 支持导入 DSH 自己的会话（2026-11-16）

用户问「DSH 不能选择会话吗？我有很多会话的呀」。原来 `dsh` 渠道被硬编码成"没有外部会话"，而 Harness 的会话其实是可读的。

### DSH 会话存哪

| 内容 | 位置 | 格式 |
|---|---|---|
| 标题/元信息 | `~/.dsh/storages/session_projcache/sessions/<id>.json` | 明文 JSON，标题在 `record.rows.title.val`（**是字符串**，不是对象） |
| 对话正文 | `~/.dsh/sessions/<workspace>/<id>/session.v4.jsonl.zstd` | **多个独立 zstd 帧顺次拼接**，一行一条记录 |

坑：Node 的 `zstdDecompressSync` 只解**第一帧**（拿到 284 字节的 session 头就停），流式解压报 `Unknown frame descriptor`。解法是按 zstd magic（`28 b5 2f fd`）切分文件、逐帧解压再拼接；一个会话实测 68 帧 / 122 条记录。

正文提取：`user/message` 取 `data.content` 的 text 块，`assistant/message` 取 `data.message.content` 的 text 块，**跳过 reasoning**，并过滤 `<system-reminder>`、`Time sampled…` 这类系统注入。

### 落地

- 新增 `lib/dsh.js`：`listSessions()`（读 projcache）+ `readContext(id, limit)`（解帧取最近对话），按 mtime 缓存。
- `lib/sessions.js`：`channel='dsh'` → `listDsh`；`lib/tools.js`：`group_sessions` 枚举加 `dsh`。
- `lib/ops.js`：dsh 成员带 `threadId` 时，把该会话最近 16 条对话压成 `[导入的既有会话《标题》]` 拼进提示词（按会话 id 缓存）；`addMember` 对 dsh 自动记 `importMode: 'context'`。
- `client.js`：dsh 也能搜索/选择会话，提示改为「只读取这条会话的历史当上下文，不会改写它」；dsh 隐藏分叉/续写（对它无意义）。

### 实测

`group_sessions(channel: 'dsh')` 列出 10 条真实会话 → 用 `session-c13496c3…`（「线上导出慢问题排查」）建 dsh 成员 → 问「我们之前排查的是哪个功能的问题？」→ 答：

> 是制单/报价单导出（Excel/PDF）线上排队慢的问题，根因是报价单预览截图占满了同一个 worker。

源会话文件 `LastWriteTime` 仍是 12:47，**确认没被写回**。

## P14 · 建群时可添加多个项目目录（2026-11-16）

参考 DSH 自己的「创建项目」弹窗：建群时能挑多个源目录。

- **目录选择用宿主的原生选择器**：客户端 `inject` 增加 `uiWorkspace`，调 `ctx.uiWorkspace.pickDirectory()`（返回绝对路径或 null），不自己造文件浏览器。
- 群多了一个 `projects: string[]`：`store.createGroup` 持久化，`listState` 回显，`group_create` 工具也支持传。
- **第一个目录成为群 `cwd`**（成员子进程的工作目录），其余写进提示词 `[项目目录]` 段：主目录 + 逐条列出，成员知道去哪找代码。
- 面板「新建群」新增「项目目录（可选，可多个）」：已选路径逐行显示（超长省略）＋行尾 ✕ 移除＋「+ 添加项目」按钮；取消弹窗后清空。

### 实测

建群时传两个目录 → `group_list` 回显 `projects: ["D:\\project\\ApparelWin_Backend","D:\\project\\ApparelWin_Frontend"]` → 问群内 dsh 成员「提示词里列出的项目目录有几条？」→ 答「两条：D:\project\ApparelWin_Backend 和 D:\project\ApparelWin_Frontend」，说明确实进了提示词。

## 最终回归（2026-11-16 收尾）

| 检查 | 结果 |
|---|---|
| 工具路径 | `group_say → DSH-主持` 1.47s 正常回复 |
| HTTP 路径 | `GET /state` → 200，2 个群、6 个成员，1191 字节 |
| 鉴权 | 无凭据 → 403（前轮已验） |
| 面板失败自述 | 403 时提示「令牌失效，请刷新页面」并带「重试」按钮 |
