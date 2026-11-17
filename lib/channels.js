import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const isWindows = process.platform === 'win32'

function exists(candidate) {
  try {
    return Boolean(candidate) && fs.existsSync(candidate)
  } catch {
    return false
  }
}

/** Prefer an explicit path, then the profile-bundled binary, then PATH. */
function resolveBinary({ configured, envName, bundledRelative, fallback }) {
  if (exists(configured)) return configured
  const fromEnv = process.env[envName]
  if (exists(fromEnv)) return fromEnv
  const profileDir =
    process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
  const bundled = path.join(profileDir, bundledRelative)
  if (exists(bundled)) return bundled
  return fallback
}

export function resolveCodexBin(configured) {
  return resolveBinary({
    configured,
    envName: 'GROUP_CHAT_CODEX_BIN',
    bundledRelative: path.join(
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe',
    ),
    fallback: 'codex',
  })
}

export function resolveClaudeBin(configured) {
  const candidates = configured
    ? [configured]
    : [
        process.env.GROUP_CHAT_CLAUDE_BIN,
        path.join(process.env.APPDATA || '', 'npm', isWindows ? 'claude.cmd' : 'claude'),
        'claude.cmd',
      ]
  for (const candidate of candidates) if (exists(candidate)) return candidate
  return isWindows ? 'claude.cmd' : 'claude'
}

/** Windows needs the whole tree killed; a bare child.kill leaves grandchildren. */
function killTree(child) {
  if (!child || child.killed) return
  try {
    if (isWindows && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    /* best effort */
  }
}

/**
 * Run one child process, streaming stdout line by line to `onLine`.
 * Resolves with the exit code and stderr tail instead of rejecting, so callers
 * can decide whether a non-zero exit is fatal.
 */
function runProcess({ bin, args, cwd, stdin, timeoutMs = 600000, signal, onLine }) {
  return new Promise((resolve) => {
    // Node refuses to spawn a .cmd/.bat directly on Windows; those need cmd.exe.
    const useShell = isWindows && /\.(cmd|bat)$/i.test(bin)
    const command = useShell ? `"${bin}"` : bin
    let child
    try {
      child = spawn(command, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: useShell,
        env: process.env,
      })
    } catch (error) {
      resolve({ code: 'spawn-error', stderr: String(error?.message || error) })
      return
    }

    let stderrTail = ''
    let buffer = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = () => {
      killTree(child)
      finish({ code: 'aborted', stderr: stderrTail })
    }
    const timer = setTimeout(() => {
      killTree(child)
      finish({ code: 'timeout', stderr: stderrTail })
    }, timeoutMs)
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) {
          try {
            onLine?.(line)
          } catch {
            /* a listener error must not kill the stream */
          }
        }
        index = buffer.indexOf('\n')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-4000)
    })
    child.on('error', (error) => {
      finish({ code: 'spawn-error', stderr: String(error?.message || error) })
    })
    child.on('close', (code) => {
      const rest = buffer.trim()
      if (rest) {
        try {
          onLine?.(rest)
        } catch {
          /* ignore */
        }
      }
      finish({ code, stderr: stderrTail })
    })

    if (stdin != null) child.stdin.end(stdin, 'utf8')
    else child.stdin.end()
  })
}

/**
 * Codex channel: `codex exec [resume <threadId>] --json ... -` with the prompt on
 * stdin. Verified event shapes:
 *   { type: 'thread.started', thread_id }
 *   { type: 'item.completed', item: { type: 'agent_message', text } }
 *   { type: 'turn.completed', usage: { input_tokens, output_tokens, ... } }
 *   { type: 'error', message }  // reconnect noise, not fatal
 */
export async function codexSay({
  bin,
  prompt,
  threadId,
  mode = 'resume',
  model,
  cwd,
  timeoutMs,
  signal,
  onEvent,
}) {
  // `--all` drops the cwd filter, so a thread recorded under another directory can
  // still be reached after being imported into a group with a different cwd.
  // `fork` seeds a NEW thread from the imported one: it reads the old context without
  // appending to the user's original history and without needing its writer lock.
  let args
  if (threadId && mode === 'fork') {
    // `fork` has no `--all` flag (unlike `resume`); an explicit id is enough.
    args = ['exec', 'fork', '--json', '--skip-git-repo-check']
  } else if (threadId) {
    args = ['exec', 'resume', '--json', '--skip-git-repo-check', '--all']
  } else {
    args = ['exec', '--json', '--skip-git-repo-check']
  }
  if (model) args.push('-m', model)
  if (threadId) args.push(threadId)
  args.push('-')

  const texts = []
  let resolvedThread = threadId || null
  let usage = null
  const notes = []

  const result = await runProcess({
    bin,
    args,
    cwd,
    stdin: prompt,
    timeoutMs,
    signal,
    onLine(line) {
      let event
      try {
        event = JSON.parse(line)
      } catch {
        return
      }
      if (event.type === 'thread.started' && event.thread_id) {
        resolvedThread = event.thread_id
        onEvent?.({ type: 'thread', threadId: resolvedThread })
        return
      }
      if (event.type === 'item.completed' && event.item) {
        if (event.item.type === 'agent_message' && event.item.text) {
          texts.push(event.item.text)
          onEvent?.({ type: 'delta', text: event.item.text })
        } else if (event.item.type === 'error' && event.item.message) {
          notes.push(event.item.message)
        }
        return
      }
      if (event.type === 'turn.completed') {
        usage = event.usage || null
        return
      }
      if (event.type === 'error' && event.message) notes.push(event.message)
    },
  })

  const text = texts.join('').trim()
  let fatal = null
  if (!text) {
    if (result.code === 'aborted') fatal = '已取消'
    else if (result.code === 'timeout') fatal = '超时未返回'
    else fatal = result.stderr || notes.join('; ') || `codex 退出码 ${result.code}`
  }
  // `codex exec --json` emits no incremental deltas (measured: one item.completed
  // carrying the whole answer), so a Codex member cannot stream tokens.
  return {
    text,
    threadId: resolvedThread,
    usage: usage ? { in: usage.input_tokens || 0, out: usage.output_tokens || 0, costUsd: null } : null,
    error: fatal,
    code: result.code,
  }
}

/**
 * Native channel: the member is just a model call through this Harness's own llm
 * service, so it costs whatever the session's route costs and carries no tools.
 */
export async function dshSay({ llm, provider, model, prompt, system, signal, onEvent }) {
  if (!llm) return { text: '', threadId: null, usage: null, error: 'llm 服务不可用' }
  if (!provider || !model) return { text: '', threadId: null, usage: null, error: '未配置 DSH 成员的 provider/model' }

  let text = ''
  let usage = null
  let error = null
  try {
    const stream = llm.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') {
        text += chunk.text
        onEvent?.({ type: 'delta', text: chunk.text })
      } else if (chunk.type === 'usage') {
        usage = chunk.usage
      } else if (chunk.type === 'finish') {
        if (chunk.reason?.kind === 'error') error = chunk.reason.failure?.message || 'llm 调用失败'
        else if (chunk.reason?.kind === 'aborted') error = '已取消'
      }
    }
  } catch (cause) {
    error = String(cause?.message || cause)
  }
  if (!error && !text.trim()) error = '模型返回空内容'
  return {
    text: text.trim(),
    threadId: null,
    usage: usage
      ? { in: usage.inputTokens || 0, out: usage.outputTokens || 0, costUsd: null }
      : null,
    error,
  }
}

export async function claudeSay({
  bin,
  prompt,
  threadId,
  forkSession = false,
  model,
  cwd,
  timeoutMs,
  signal,
  onEvent,
}) {
  // stream-json + --include-partial-messages is the only Claude mode that yields real
  // token deltas (`stream_event/content_block_delta`); the trailing `result` event
  // carries the authoritative text, session id, usage and cost.
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--bare',
  ]
  if (threadId) {
    args.push('--resume', threadId)
    if (forkSession) args.push('--fork-session')
  }
  if (model) args.push('--model', model)

  let streamed = ''
  let finalText = ''
  let sessionId = threadId || null
  let usage = null
  let errorText = null
  let sawResult = false

  const proc = await runProcess({
    bin,
    args,
    cwd,
    stdin: prompt,
    timeoutMs,
    signal,
    onLine(line) {
      let event
      try {
        event = JSON.parse(line)
      } catch {
        return
      }
      if (event.session_id) sessionId = event.session_id

      if (event.type === 'stream_event' && event.event) {
        const inner = event.event
        if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
          const piece = inner.delta.text || ''
          if (piece) {
            streamed += piece
            onEvent?.({ type: 'delta', text: piece })
          }
        }
        return
      }

      if (event.type === 'result') {
        sawResult = true
        finalText = String(event.result || '')
        if (event.session_id) sessionId = event.session_id
        if (event.usage) {
          usage = {
            in: event.usage.input_tokens || 0,
            out: event.usage.output_tokens || 0,
            costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null,
          }
        }
        if (event.is_error) errorText = String(event.result || 'claude 返回错误')
      }
    },
  })

  const text = (finalText || streamed).trim()
  if (!sawResult && !text) {
    const reason =
      proc.code === 'aborted'
        ? '已取消'
        : proc.code === 'timeout'
          ? '超时未返回'
          : proc.stderr || `claude 退出码 ${proc.code}`
    return { text: '', threadId: sessionId, usage, error: reason, code: proc.code }
  }
  if (errorText) {
    return { text: '', threadId: sessionId, usage, error: errorText, code: proc.code }
  }
  return {
    text,
    threadId: sessionId,
    usage,
    error: text ? null : 'claude 返回空内容',
    code: proc.code,
  }
}
