/**
 * Discovery for existing Codex / Claude Code / DSH conversations, so a group member can
 * take one over instead of copying a summary into a fresh thread.
 *
 * Codex:   ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl
 *          line 0 is { type: 'session_meta', payload: { session_id, cwd, timestamp } }
 * Claude:  ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 *          lines are { type: 'user' | 'assistant', sessionId, cwd, message: { content } }
 * DSH:     titles come from storages/session_projcache; transcripts from lib/dsh.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listSessions as listDsh } from './dsh.js'

const HEAD_BYTES = 262144
const TITLE_CHARS = 120

function walkJsonl(dir, out, depth = 0) {
  if (depth > 5) return out
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkJsonl(full, out, depth + 1)
    else if (entry.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

function newestFiles(dir, limit) {
  const files = walkJsonl(dir, [])
  return files
    .map((file) => {
      try {
        return { file, mtime: fs.statSync(file).mtimeMs }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, limit)
}

function headLines(file) {
  let handle
  try {
    handle = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(HEAD_BYTES)
    const read = fs.readSync(handle, buffer, 0, HEAD_BYTES, 0)
    return buffer.subarray(0, read).toString('utf8').split('\n')
  } catch {
    return []
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle)
      } catch {
        /* ignore */
      }
    }
  }
}

function clip(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length > TITLE_CHARS ? `${flat.slice(0, TITLE_CHARS)}…` : flat
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join(' ')
  }
  return ''
}

function listCodex(limit) {
  const root = path.join(os.homedir(), '.codex', 'sessions')
  const out = []
  for (const { file, mtime } of newestFiles(root, limit * 3)) {
    const lines = headLines(file)
    if (!lines.length) continue
    let meta = null
    let title = ''
    for (const line of lines) {
      if (!line.trim()) continue
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (!meta && parsed.type === 'session_meta' && parsed.payload) {
        meta = parsed.payload
        continue
      }
      const payload = parsed.payload
      if (
        !title &&
        payload &&
        payload.type === 'message' &&
        payload.role === 'user'
      ) {
        const text = clip(textOfContent(payload.content))
        // Codex injects a developer/skills preamble; the first real user text is the title.
        if (text && !text.startsWith('<')) title = text
      }
      if (meta && title) break
    }
    if (!meta?.session_id) continue
    out.push({
      channel: 'codex',
      id: meta.session_id,
      title: title || '(无标题会话)',
      cwd: meta.cwd || null,
      updatedAt: new Date(meta.timestamp || mtime).toISOString(),
      source: path.relative(root, file),
    })
    if (out.length >= limit) break
  }
  return out
}

function listClaude(limit) {
  const root = path.join(os.homedir(), '.claude', 'projects')
  const out = []
  for (const { file, mtime } of newestFiles(root, limit * 3)) {
    const lines = headLines(file)
    let meta = null
    let title = ''
    for (const line of lines) {
      if (!line.trim()) continue
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (parsed.sessionId && !meta) meta = parsed
      if (
        !title &&
        parsed.type === 'user' &&
        parsed.message &&
        parsed.message.role === 'user'
      ) {
        const text = clip(textOfContent(parsed.message.content))
        if (text) title = text
      }
      if (meta && title) break
    }
    const id = meta?.sessionId || path.basename(file, '.jsonl')
    if (!id) continue
    out.push({
      channel: 'claude',
      id,
      title: title || '(无标题会话)',
      cwd: meta?.cwd || null,
      updatedAt: new Date(meta?.timestamp || mtime).toISOString(),
      source: path.relative(root, file),
    })
    if (out.length >= limit) break
  }
  return out
}

export function listSessions({ channel, limit = 20 }) {
  const capped = Math.min(Math.max(Number(limit) || 20, 1), 100)
  if (channel === 'codex') return listCodex(capped)
  if (channel === 'claude') return listClaude(capped)
  if (channel === 'dsh') return listDsh(capped)
  return [...listDsh(capped), ...listCodex(capped), ...listClaude(capped)]
}
