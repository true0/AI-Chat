/** Model-facing tools. Every tool delegates to the shared object in lib/ops.js. */

const OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

function asText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export function createGroupTools({ ops }) {
  const tools = [
    {
      name: 'group_create',
      description:
        '创建一个群聊房间。群聊用独立面板显示，成员来自 Codex / Claude Code 等渠道。cwd 决定成员的工作目录。',
      parameters: {
        name: { type: 'string', required: true, description: '群名' },
        cwd: { type: 'string', description: '成员的工作目录，默认当前会话目录' },
        projects: {
          type: 'array',
          items: { type: 'string' },
          description: '项目目录列表。第一个会成为成员的工作目录，其余会写进提示词作为可参考的项目',
        },
        brief: { type: 'string', description: '群背景说明（十行以内），每轮拼进成员提示词' },
        template: {
          type: 'string',
          enum: ['dev', 'review', 'research'],
          description:
            '建群时自动装配成员：dev=架构师(codex)+实现(claude)+审校(dsh)；review=主审(claude)+复核(dsh)；research=调研(dsh)+收敛(codex)。省略则建空群。',
        },
      },
      execute: (args, exec) => ops.createGroup({ ...args, agent: exec?.agent }),
    },
    {
      name: 'group_list',
      description: '列出所有群聊及其成员。返回摘要，不含聊天全文。',
      parameters: {},
      execute: () => ops.listState(),
    },
    {
      name: 'group_add_member',
      description:
        '给群聊添加一个 AI 成员。codex / claude 起独立子进程并保留各自登录，首次发言后记住会话 id、后续自动续接；dsh 用当前 Harness 的模型服务，无外部依赖。传 threadId 可接管一个已有会话（配合 mode 选择 fork 或 resume）。',
      parameters: {
        groupId: { type: 'string', required: true, description: '群 id' },
        channel: {
          type: 'string',
          required: true,
          enum: ['codex', 'claude', 'dsh'],
          description:
            '渠道。codex / claude 起独立子进程，保留各自登录与会话；dsh 用当前 Harness 的模型服务，最省钱也没有外部依赖。',
        },
        name: { type: 'string', required: true, description: '成员显示名' },
        role: { type: 'string', description: '职责描述，会写进成员的提示词' },
        model: { type: 'string', description: '模型名；不填用渠道默认' },
        threadId: {
          type: 'string',
          description: '已有会话 id（codex thread_id 或 claude session_id），填了就接管该会话',
        },
        mode: {
          type: 'string',
          enum: ['fork', 'resume'],
          description:
            '接管方式。fork（默认）= 从旧会话分叉出新线程，读得到上下文但不改原历史、也不受写锁限制；resume = 续写原线程，若该会话正被别的进程占用会失败。',
        },
      },
      execute: (args) => ops.addMember({ ...args, importMode: args.mode }),
    },
    {
      name: 'group_say',
      description:
        '在群聊里发言，并让指定成员回复。members 省略时发给全体成员。默认逐个执行；profile 里 maxParallelMembers > 1 时成员并发。每次回复都会写入群的聊天记录。',
      parameters: {
        groupId: { type: 'string', required: true, description: '群 id' },
        text: { type: 'string', required: true, description: '你要说的话' },
        members: {
          type: 'array',
          description: '目标成员 id 列表；省略表示全体',
          items: { type: 'string' },
        },
      },
      async execute(args, exec) {
        const result = await ops.say({
          groupId: args.groupId,
          text: args.text,
          memberIds: args.members,
          signal: exec?.signal,
        })
        return {
          groupId: result.groupId,
          replies: result.replies.map((reply) => ({
            member: reply.member,
            channel: reply.channel,
            ok: reply.ok,
            ms: reply.ms,
            seq: reply.seq,
            text: reply.text.length > 1200 ? `${reply.text.slice(0, 1200)}…` : reply.text,
          })),
        }
      },
    },
    {
      name: 'group_transcript',
      description: '读取群聊的最近消息。用 sinceSeq 增量拉取。',
      parameters: {
        groupId: { type: 'string', required: true, description: '群 id' },
        sinceSeq: { type: 'integer', description: '只取该序号之后的消息，默认 0' },
        limit: { type: 'integer', description: '最多返回条数，默认 30' },
      },
      async execute(args) {
        const { entries } = ops.transcript({
          groupId: args.groupId,
          sinceSeq: args.sinceSeq,
          limit: Number(args.limit) || 30,
        })
        return {
          count: entries.length,
          entries: entries.map((entry) => ({
            seq: entry.seq,
            author: entry.author,
            kind: entry.kind,
            text: entry.text.length > 800 ? `${entry.text.slice(0, 800)}…` : entry.text,
          })),
        }
      },
    },
    {
      name: 'group_sessions',
      description:
        '列出本机已有的 Codex / Claude Code / DSH 会话，用于把某个成员接管到旧会话上（把返回的 id 作为 group_add_member 的 threadId）。dsh 是只读导入：只把历史当上下文，不写回原会话。',
      parameters: {
        channel: {
          type: 'string',
          enum: ['codex', 'claude', 'dsh'],
          description: '只看某个渠道；省略则三个渠道都列',
        },
        limit: { type: 'integer', description: '每个渠道最多返回条数，默认 10' },
      },
      execute: (args) =>
        ops.listSessions({ channel: args.channel, limit: Number(args.limit) || 10 }),
    },
    {
      name: 'group_export',
      description: '把群聊记录导出成 Markdown 纪要，写到该群的工作目录，返回文件路径。',
      parameters: {
        groupId: { type: 'string', required: true, description: '群 id' },
      },
      execute: (args) => ops.exportMinutes({ groupId: args.groupId }),
    },
    {
      name: 'group_usage',
      description: '查看一个群的 token 用量与花费估算：总输入/输出、今日用量、调用次数。',
      parameters: {
        groupId: { type: 'string', required: true, description: '群 id' },
      },
      execute: (args) => ops.usage({ groupId: args.groupId }),
    },
    {
      name: 'group_rename',
      description: '给群聊改名字。',
      parameters: {
        groupId: { type: 'string', required: true, description: '群 id' },
        name: { type: 'string', required: true, description: '新群名' },
      },
      execute: (args) => ops.renameGroup({ groupId: args.groupId, name: args.name }),
    },
    {
      name: 'group_remove',
      description:
        '把群聊从列表里移除。**聊天记录不会被删除**，会保留到 `$DSH_HOME/storages/group-chat/archive/`，可随时用 group_archives 查回。进行中有发言的群需要先取消。',
      parameters: {
        groupId: { type: 'string', required: true, description: '群 id' },
      },
      execute: (args) => ops.removeGroup({ groupId: args.groupId }),
    },
    {
      name: 'group_archives',
      description: '列出已移除群聊保留下来的聊天记录（群名、条数、移除时间、归档文件位置）。',
      parameters: {},
      execute: () => ops.listArchives(),
    },
    {
      name: 'group_restore',
      description: '把已移除的群聊恢复回列表。聊天记录、成员以及成员已绑定的会话 id 都会一并恢复。',
      parameters: {
        groupId: { type: 'string', required: true, description: '归档记录里的群 id' },
      },
      execute: (args) => ops.restoreGroup({ groupId: args.groupId }),
    },
  ]

  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    output: OUTPUT,
    async execute(args, exec) {
      return asText(await tool.execute(args || {}, exec))
    },
  }))
}
