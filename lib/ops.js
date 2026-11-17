import fs from 'node:fs'
import path from 'node:path'
import { claudeSay, codexSay, dshSay, resolveClaudeBin, resolveCodexBin } from './channels.js'
import { listSessions } from './sessions.js'
import { readContext } from './dsh.js'

const SYSTEM_RULE =
  '这是多人讨论。你只代表你自己的角色；结论先行；不要复述别人的话，不要模仿别人的口吻。'

/** Ready-made rosters: a new room is useful before anyone configures members. */
const TEMPLATES = {
  dev: [
    { channel: 'codex', name: '架构师', role: '负责架构与取舍，结论先行，不复述别人' },
    { channel: 'claude', name: '实现', role: '负责落地实现与细节，给出可执行步骤' },
    { channel: 'dsh', name: '审校', role: '负责挑错与风险，指出具体问题' },
  ],
  review: [
    { channel: 'claude', name: '主审', role: '负责逐条审查，指出具体文件与行' },
    { channel: 'dsh', name: '复核', role: '负责交叉验证结论，给反例或明确无异议' },
  ],
  research: [
    { channel: 'dsh', name: '调研', role: '负责铺开信息与可能性，标注不确定处' },
    { channel: 'codex', name: '收敛', role: '负责在候选方案里做取舍并给结论' },
  ],
}

const MAX_PROMPT_CHARS = 6000
const MAX_RECENT_ENTRIES = 12
const IMPORT_CACHE = new Map()

/**
 * 把一个既有 DSH 会话的历史压缩成背景段落。只读，不写回原会话。
 * 结果按会话 id 缓存，避免每个成员每轮都解压日志。
 */
function importedContext(sessionId) {
  const cached = IMPORT_CACHE.get(sessionId)
  if (cached !== undefined) return cached
  let block = null
  try {
    const imported = readContext(sessionId, { limit: 16 })
    if (imported && imported.messages.length) {
      const lines = imported.messages.map((message) => `${message.role === 'user' ? '我' : '你'}：${message.text}`)
      let body = lines.join('\n')
      if (body.length > MAX_PROMPT_CHARS) body = `…省略前文…\n${body.slice(body.length - MAX_PROMPT_CHARS)}`
      block = `[导入的既有会话《${imported.title || sessionId.slice(0, 8)}》]\n以下是你在那条会话里和我的历史对话，供你延续上下文；本轮请照常回答群里的问题。\n${body}`
    }
  } catch {
    block = null
  }
  IMPORT_CACHE.set(sessionId, block)
  return block
}

function buildPrompt(group, member, history, text) {
  const recent = history.slice(-MAX_RECENT_ENTRIES)
  const parts = []
  if (member.role) parts.push(`[角色] ${member.role}`)
  parts.push(`[群规] ${SYSTEM_RULE}`)
  if (group.brief) parts.push(`[背景]\n${group.brief}`)
  const projects = Array.isArray(group.projects) ? group.projects.filter(Boolean) : []
  if (projects.length > 0) {
    parts.push(`[项目目录]\n主目录：${group.cwd}\n${projects.map((item) => `- ${item}`).join('\n')}`)
  }
  if (recent.length > 0) {
    const lines = recent.map((entry) => `${entry.author}：${entry.text}`)
    let body = lines.join('\n')
    if (body.length > MAX_PROMPT_CHARS) {
      body = `…省略前文…\n${body.slice(body.length - MAX_PROMPT_CHARS)}`
    }
    parts.push(`[近期消息]\n${body}`)
  }
  parts.push(`[本轮]\n${text}`)
  return parts.join('\n\n')
}

/** Normalize one entry's stored usage across channels and transcript generations. */
function entryUsage(entry) {
  const usage = entry?.usage
  if (!usage) return { in: 0, out: 0, costUsd: 0 }
  const input = usage.in ?? usage.input_tokens ?? usage.inputTokens ?? 0
  const output = usage.out ?? usage.output_tokens ?? usage.outputTokens ?? 0
  const cost = usage.costUsd ?? usage.total_cost_usd ?? 0
  return { in: Number(input) || 0, out: Number(output) || 0, costUsd: Number(cost) || 0 }
}

function sumUsage(entries) {
  const today = new Date().toISOString().slice(0, 10)
  let totalIn = 0
  let totalOut = 0
  let totalCost = 0
  let calls = 0
  let todayIn = 0
  let todayOut = 0
  for (const entry of entries) {
    if (!entry.usage) continue
    const usage = entryUsage(entry)
    totalIn += usage.in
    totalOut += usage.out
    totalCost += usage.costUsd
    calls += 1
    if (String(entry.at || '').slice(0, 10) === today) {
      todayIn += usage.in
      todayOut += usage.out
    }
  }
  return {
    totalIn,
    totalOut,
    totalCostUsd: Number(totalCost.toFixed(6)),
    calls,
    todayIn,
    todayOut,
    todayTotal: todayIn + todayOut,
  }
}

function explainError(message) {  if (!message) return ''
  if (message.includes('active writer')) {
    return '该会话正被另一个 Codex 进程占用（可能开在 Codex 桌面端）。改用 mode=fork 可绕过写锁并保留上下文。'
  }
  if (message.includes('No conversation found') || message.includes('not found')) {
    return `${message}（Claude 的会话按项目目录存放，导入时工作目录需与原来一致）`
  }
  return message
}

function summarizeMember(member) {
  return {
    id: member.id,
    name: member.name,
    channel: member.channel,
    model: member.model,
    role: member.role,
    hasThread: Boolean(member.threadId),
    importMode: member.importMode || 'resume',
  }
}

/**
 * The single implementation of every group operation. Agent tools and the panel's
 * HTTP resource both call these methods, so the two callers cannot drift.
 */
export function createOps({ store, config = {} }) {
  /** groupId -> AbortController for the turn currently running in that room. */
  const running = new Map()
  /** groupId -> the member turn currently producing text, for the live panel view. */
  const live = new Map()

  const ops = {
    listState() {
      return {
        groups: store.listGroups().map((group) => ({
          id: group.id,
          name: group.name,
          cwd: group.cwd,
          brief: group.brief,
          projects: group.projects || [],
          lastSeq: store.lastSeq(group.id),
          last: store.lastEntry(group.id),
          busy: running.has(group.id),
          members: group.members.map(summarizeMember),
        })),
      }
    },

    createGroup({ name, cwd, brief, template, agent, projects }) {
      // 显式路径优先；其次是「项目目录」的第一个；再退到调用方会话目录与 harness 默认目录。
      const extra = Array.isArray(projects)
        ? projects.map((item) => String(item || '').trim()).filter(Boolean)
        : []
      let resolved = cwd || extra[0]
      if (!resolved && agent && typeof config.resolveCwd === 'function') {
        try {
          resolved = config.resolveCwd(agent)
        } catch {
          resolved = undefined
        }
      }
      const group = store.createGroup({
        name,
        cwd: resolved || config.defaultCwd || process.cwd(),
        brief: brief || '',
        projects: extra,
      })
      const roster = TEMPLATES[String(template || '').trim()]
      if (roster) {
        for (const entry of roster) {
          store.addMember(group.id, { ...entry })
        }
      }
      return {
        group: { id: group.id, name: group.name, cwd: group.cwd, projects: group.projects || [] },
        template: roster ? String(template) : null,
        members: roster ? roster.map((entry) => entry.name) : [],
      }
    },

    addMember(input) {
      const member = store.addMember(input.groupId, {
        channel: input.channel,
        name: input.name,
        role: input.role,
        model: input.model,
        threadId: input.threadId,
        // dsh 成员只会把既有会话的历史读进来当上下文，永远不会写回那条会话。
        importMode: input.importMode || (input.channel === 'dsh' && input.threadId ? 'context' : undefined),
      })
      return { member: summarizeMember(member) }
    },

    listSessions({ channel, limit }) {
      return { sessions: listSessions({ channel, limit }) }
    },

    renameGroup({ groupId, name }) {
      const renamed = store.renameGroup(groupId, name)
      if (!renamed) throw new Error(`找不到群 ${groupId}`)
      return { renamed: true, group: renamed }
    },

    removeGroup({ groupId }) {      if (running.has(groupId)) throw new Error('该群有进行中的发言，先取消再移除')
      const archived = store.archiveGroup(groupId)
      if (!archived) throw new Error(`找不到群 ${groupId}`)
      return {
        removed: true,
        groupId: archived.groupId,
        name: archived.name,
        messages: archived.messages,
        transcript: archived.transcript,
        note: '群已从列表移除，聊天记录保留在 archive/ 下，没有删除。',
      }
    },

    listArchives() {
      return {
        archives: store.listArchives().map((record) => ({
          id: record.id,
          name: record.name,
          cwd: record.cwd,
          members: record.members,
          messages: record.messages,
          removedAt: record.removedAt,
          transcript: record.transcript,
          restorable: Boolean(record.snapshot),
        })),
      }
    },

    restoreGroup({ groupId }) {
      const group = store.restoreGroup(groupId)
      if (!group) throw new Error(`找不到归档记录 ${groupId}`)
      return {
        restored: true,
        group: {
          id: group.id,
          name: group.name,
          members: Array.isArray(group.members) ? group.members.length : 0,
        },
        note: '群已恢复到列表，聊天记录和成员（含已绑定的会话 id）都还在。',
      }
    },

    transcript({ groupId, sinceSeq, limit }) {
      const entries = store.readTranscript(
        groupId,
        Number(sinceSeq) || 0,
        Math.min(Math.max(Number(limit) || 50, 1), 200),
      )
      return {
        entries: entries.map((entry) => ({
          seq: entry.seq,
          at: entry.at,
          author: entry.author,
          memberId: entry.memberId,
          channel: entry.channel,
          kind: entry.kind,
          text: entry.text.length > 4000 ? `${entry.text.slice(0, 4000)}…` : entry.text,
          ms: entry.ms ?? null,
        })),
      }
    },

    async say({ groupId, text, memberIds, signal, onProgress }) {
      const group = store.getGroup(groupId)
      if (!group) throw new Error(`找不到群 ${groupId}`)
      if (!group.members.length) throw new Error('群内还没有成员')
      if (!fs.existsSync(group.cwd)) throw new Error(`群工作目录不存在：${group.cwd}`)

      const wanted =
        Array.isArray(memberIds) && memberIds.length
          ? group.members.filter((member) => memberIds.includes(member.id))
          : group.members
      if (!wanted.length) throw new Error('指定的成员都不在这个群里')

      const clean = String(text || '').trim()
      if (!clean) throw new Error('内容不能为空')

      // Daily budget gate: refuses before spending anything, and reports the numbers
      // so the caller can raise the limit instead of guessing.
      const budget = Number(config.dailyTokenBudget ?? 1_000_000)
      if (budget > 0) {
        const used = sumUsage(store.readTranscript(group.id, 0, 100000)).todayTotal
        if (used >= budget) {
          throw new Error(`该群今日已用 ${used} tokens，超过上限 ${budget}（可在 profile 里调整 dailyTokenBudget）`)
        }
      }

      store.appendTranscript(group.id, {
        seq: store.nextSeq(group.id),
        at: new Date().toISOString(),
        kind: 'message',
        author: '你',
        memberId: null,
        channel: null,
        text: clean,
      })

      const limit = Math.max(1, Math.min(Number(config.maxParallelMembers) || 1, 8))
      const runMember = async (member) => {
        // Members see the shared room history; their own prior turns stay in it so a
        // resumed session and the visible context agree.
        const history = store.readTranscript(group.id, 0, 500)
        let prompt = buildPrompt(group, member, history, clean)
        // dsh 成员绑定了既有 Harness 会话时，只读取它的历史当上下文，不写回那条会话。
        if (member.channel === 'dsh' && member.threadId) {
          const imported = importedContext(member.threadId)
          if (imported) prompt = `${imported}\n\n${prompt}`
        }
        const started = Date.now()
        onProgress?.({ phase: 'start', member: member.name, channel: member.channel })
        // Live buffer for the panel: only Claude and DSH emit real token deltas.
        const liveKey = `${group.id}\u0000${member.id}`
        live.set(liveKey, {
          memberId: member.id,
          name: member.name,
          channel: member.channel,
          text: '',
          startedAt: started,
          streaming: member.channel !== 'codex',
        })
        const onEvent = (event) => {
          if (event?.type !== 'delta') return
          const current = live.get(liveKey)
          if (current) current.text += event.text
        }

        let outcome
        if (member.channel === 'codex') {
          outcome = await codexSay({
            bin: resolveCodexBin(config.codexBin),
            prompt,
            threadId: member.threadId,
            mode: member.importMode || 'resume',
            model: member.model || config.codexModel,
            cwd: group.cwd,
            timeoutMs: config.timeoutMs || 600000,
            signal,
            onEvent,
          })
        } else if (member.channel === 'claude') {
          outcome = await claudeSay({
            bin: resolveClaudeBin(config.claudeBin),
            prompt,
            threadId: member.threadId,
            forkSession: member.importMode === 'fork',
            model: member.model || config.claudeModel,
            cwd: group.cwd,
            timeoutMs: config.timeoutMs || 600000,
            signal,
            onEvent,
          })
        } else if (member.channel === 'dsh') {
          outcome = await dshSay({
            llm: config.llm,
            provider: member.provider || config.dshProvider,
            model: member.model || config.dshModel,
            system: SYSTEM_RULE,
            prompt,
            signal,
            onEvent,
          })
        } else {
          outcome = { text: '', threadId: member.threadId, error: `未支持的渠道 ${member.channel}` }
        }
        live.delete(`${group.id}\u0000${member.id}`)

        if (outcome.threadId && outcome.threadId !== member.threadId) {
          // A fork produces a thread we now own: continue it with `resume` from the
          // next turn on, otherwise every message would fork a brand-new thread.
          const patch = { threadId: outcome.threadId }
          if (member.importMode === 'fork') patch.importMode = 'resume'
          store.updateMember(group.id, member.id, patch)
          member.threadId = outcome.threadId
          if (patch.importMode) member.importMode = patch.importMode
        }

        const entry = {
          seq: store.nextSeq(group.id),
          at: new Date().toISOString(),
          kind: outcome.error ? 'error' : 'message',
          author: member.name,
          memberId: member.id,
          channel: member.channel,
          text: outcome.error ? `[失败] ${explainError(outcome.error)}` : outcome.text,
          ms: Date.now() - started,
          usage: outcome.usage || null,
        }
        store.appendTranscript(group.id, entry)
        onProgress?.({ phase: 'done', member: member.name, ok: !outcome.error })
        return {
          memberId: member.id,
          member: member.name,
          channel: member.channel,
          ok: !outcome.error,
          seq: entry.seq,
          ms: entry.ms,
          text: entry.text,
        }
      }

      // Bounded worker pool: maxParallelMembers defaults to 1, i.e. one member at a time.
      const replies = new Array(wanted.length)
      let cursor = 0
      await Promise.all(
        Array.from({ length: Math.min(limit, wanted.length) }, async () => {
          for (;;) {
            const index = cursor
            cursor += 1
            if (index >= wanted.length) return
            replies[index] = await runMember(wanted[index])
          }
        }),
      )

      return { groupId: group.id, replies }
    },

    /**
     * Fire-and-forget turn for the panel: one member can take two minutes, so the
     * answer arrives through the transcript poll instead of a hanging HTTP request.
     */
    startSay({ groupId, text, memberIds }) {
      if (running.has(groupId)) throw new Error('该群上一条发言还在进行中')
      const controller = new AbortController()
      running.set(groupId, controller)
      ops.say({ groupId, text, memberIds, signal: controller.signal })
        .catch((error) => {
          try {
            store.appendTranscript(groupId, {
              seq: store.nextSeq(groupId),
              at: new Date().toISOString(),
              kind: 'error',
              author: '系统',
              memberId: null,
              channel: null,
              text: `[失败] ${String(error?.message || error)}`,
            })
          } catch {
            /* the room vanished mid-turn */
          }
        })
        .finally(() => {
          running.delete(groupId)
        })
      return { accepted: true }
    },

    cancelSay({ groupId }) {
      const controller = running.get(groupId)
      if (!controller) return { cancelled: false, reason: '没有进行中的发言' }
      controller.abort()
      return { cancelled: true }
    },

    isBusy(groupId) {
      return running.has(groupId)
    },

    status({ groupId }) {
      const prefix = `${groupId}\u0000`
      const active = []
      for (const [key, entry] of live) {
        if (!key.startsWith(prefix)) continue
        active.push({
          memberId: entry.memberId,
          name: entry.name,
          channel: entry.channel,
          text: entry.text,
          streaming: entry.streaming,
          ms: Date.now() - entry.startedAt,
        })
      }
      active.sort((left, right) => left.memberId.localeCompare(right.memberId))
      return { groupId, busy: running.has(groupId), live: active }
    },

    usage({ groupId }) {
      return { groupId, ...sumUsage(store.readTranscript(groupId, 0, 100000)) }
    },

    exportMinutes({ groupId }) {
      const group = store.getGroup(groupId)
      if (!group) throw new Error(`找不到群 ${groupId}`)
      const entries = store.readTranscript(groupId, 0, 100000)
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const lines = [
        `# ${group.name} · 群聊纪要`,
        '',
        `- 导出时间：${new Date().toISOString()}`,
        `- 工作目录：${group.cwd}`,
        `- 成员：${group.members.map((m) => `${m.name}（${m.channel}${m.model ? `/${m.model}` : ''}）`).join('、')}`,
      ]
      if (group.brief) lines.push(`- 背景：${group.brief}`)
      lines.push('', '---', '')
      for (const entry of entries) {
        const who = entry.channel ? `${entry.author}（${entry.channel}）` : entry.author
        lines.push(`**${who}**${entry.ms ? ` · ${Math.round(entry.ms / 1000)}s` : ''}`, '', entry.text, '')
      }
      const markdown = lines.join('\n')
      const dir = fs.existsSync(group.cwd) ? group.cwd : process.cwd()
      const file = path.join(dir, `群聊纪要-${stamp}.md`)
      fs.writeFileSync(file, markdown, 'utf8')
      return { file, bytes: Buffer.byteLength(markdown), messages: entries.length }
    },
  }

  return ops
}
