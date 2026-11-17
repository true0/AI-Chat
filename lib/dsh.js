/**
 * Read-only access to DeepSeek Harness's own sessions.
 *
 * Listing comes from the projection cache (`storages/session_projcache/sessions/<id>.json`),
 * which already carries the session title. The conversation itself lives in
 * `sessions/<workspace>/<id>/session.v4.jsonl.zstd`: a *concatenation* of independent zstd
 * frames, one per flush. Node's stream decoder stops after the first frame, so we split the
 * file on the zstd magic bytes and decode every frame separately.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const CACHE = new Map()

function dshRoot() {
  return path.join(os.homedir(), '.dsh')
}

function sessionFile(sessionId) {
  const root = path.join(dshRoot(), 'sessions')
  let workspaces
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const candidate = path.join(root, workspace.name, sessionId, 'session.v4.jsonl.zstd')
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/** Every frame of the log, decoded and parsed. Cached by (path, mtime, size). */
function readLog(sessionId) {
  const file = sessionFile(sessionId)
  if (!file) return null
  const stat = fs.statSync(file)
  const key = `${file}:${stat.mtimeMs}:${stat.size}`
  const cached = CACHE.get(key)
  if (cached) return cached

  const buffer = fs.readFileSync(file)
  const starts = []
  let at = 0
  while ((at = buffer.indexOf(ZSTD_MAGIC, at)) !== -1) {
    starts.push(at)
    at += 4
  }
  const chunks = []
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index]
    const to = index + 1 < starts.length ? starts[index + 1] : buffer.length
    try {
      chunks.push(zlib.zstdDecompressSync(buffer.subarray(from, to)))
    } catch {
      /* a torn tail frame is normal while a session is being written */
    }
  }
  const records = []
  for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      /* skip malformed line */
    }
  }
  const result = { file, records }
  CACHE.set(key, result)
  if (CACHE.size > 24) CACHE.delete(CACHE.keys().next().value)
  return result
}

/** title 投影的取值可能是字符串，也可能是 { title } 对象。 */
function titleOf(value) {
  if (typeof value === 'string') return value
  if (value && typeof value.title === 'string') return value.title
  return ''
}

function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** 系统注入的提醒/时间上下文不该当成对话内容导入。 */
function isNoise(text) {
  const head = text.trimStart()
  return head.startsWith('<system-reminder>') || head.startsWith('Time sampled while preparing turn')
}

function listSessions({ limit = 30 } = {}) {
  const dir = path.join(dshRoot(), 'storages', 'session_projcache', 'sessions')
  let files
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
  const sessions = []
  for (const name of files) {
    const full = path.join(dir, name)
    let stat
    let parsed
    try {
      stat = fs.statSync(full)
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'))
    } catch {
      continue
    }
    const record = parsed?.record || {}
    const id = name.replace(/\.json$/, '')
    const title = titleOf(record.rows?.title?.val)
    if (!title) continue
    sessions.push({
      channel: 'dsh',
      id,
      title: String(title).slice(0, 80),
      cwd: record.identity?.cwd || '',
      updatedAt: new Date(stat.mtimeMs).toISOString(),
    })
  }
  sessions.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
  return sessions.slice(0, limit)
}

/** 会话标题 + 最近若干条对话（用户与助手的正文，去掉系统注入与推理）。 */
function readContext(sessionId, { limit = 20 } = {}) {
  const log = readLog(sessionId)
  if (!log) return null
  const messages = []
  let title = ''
  for (const record of log.records) {
    if (record.type === 'session/title' && record.data?.title) title = record.data.title
    if (record.type === 'user/message') {
      const text = textOf(record.data?.content)
      if (text && !isNoise(text)) messages.push({ role: 'user', text })
    }
    if (record.type === 'assistant/message') {
      const text = textOf(record.data?.message?.content)
      if (text) messages.push({ role: 'assistant', text })
    }
  }
  if (!title) title = readTitleFromCache(sessionId)
  return { title, messages: messages.slice(-limit) }
}

function readTitleFromCache(sessionId) {
  try {
    const file = path.join(dshRoot(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return titleOf(parsed?.record?.rows?.title?.val)
  } catch {
    return ''
  }
}

export { listSessions, readContext }
