import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Durable group state lives beside the other Harness storages. */
export function storeRoot() {
  return path.join(os.homedir(), '.dsh', 'storages', 'group-chat')
}

function ensureDirs() {
  fs.mkdirSync(path.join(storeRoot(), 'transcripts'), { recursive: true })
  fs.mkdirSync(path.join(storeRoot(), 'archive'), { recursive: true })
}

function groupsFile() {
  return path.join(storeRoot(), 'groups.json')
}

function transcriptFile(groupId) {
  return path.join(storeRoot(), 'transcripts', `${groupId}.jsonl`)
}

function archiveIndexFile() {
  return path.join(storeRoot(), 'archive', 'index.json')
}

function newId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
  const rand = Math.random().toString(36).slice(2, 6)
  return `${prefix}_${stamp}_${rand}`
}

export class GroupStore {
  constructor() {
    this.state = this.#load()
  }

  #load() {
    ensureDirs()
    try {
      const raw = fs.readFileSync(groupsFile(), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && Array.isArray(parsed.groups)) return parsed
    } catch {
      /* first run or unreadable state: start empty */
    }
    return { version: 1, groups: [] }
  }

  #save() {
    ensureDirs()
    const tmp = `${groupsFile()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    fs.renameSync(tmp, groupsFile())
  }

  listGroups() {
    return this.state.groups.map((group) => ({
      id: group.id,
      name: group.name,
      cwd: group.cwd,
      brief: group.brief ?? '',
      members: group.members.map((member) => ({ ...member })),
    }))
  }

  getGroup(groupId) {
    return this.state.groups.find((group) => group.id === groupId)
  }

  createGroup({ name, cwd, brief = '', projects = [] }) {
    if (!name || !String(name).trim()) throw new Error('group_create 需要 name')
    const group = {
      id: newId('g'),
      name: String(name).trim(),
      cwd: cwd || process.cwd(),
      brief,
      projects: Array.isArray(projects) ? projects.map((item) => String(item).trim()).filter(Boolean) : [],
      createdAt: new Date().toISOString(),
      members: [],
    }
    this.state.groups.push(group)
    this.#save()
    return group
  }

  addMember(groupId, member) {
    const group = this.getGroup(groupId)
    if (!group) throw new Error(`找不到群 ${groupId}`)
    const channels = ['codex', 'claude', 'dsh']
    if (!channels.includes(member.channel)) {
      throw new Error(`channel 必须是 ${channels.join(' / ')} 之一`)
    }
    const created = {
      id: newId('m'),
      name: String(member.name || member.channel).trim(),
      role: member.role || '',
      channel: member.channel,
      model: member.model || null,
      permissionMode: member.permissionMode || 'never',
      threadId: member.threadId || null,
      // An imported session defaults to `fork`: it reads the old context without
      // appending to the user's original history or needing its writer lock.
      importMode: member.importMode || (member.threadId ? 'fork' : 'resume'),
      createdAt: new Date().toISOString(),
    }
    group.members.push(created)
    this.#save()
    return created
  }

  updateMemberThread(groupId, memberId, threadId) {
    const group = this.getGroup(groupId)
    const member = group?.members.find((item) => item.id === memberId)
    if (!member) return
    member.threadId = threadId
    this.#save()
  }

  updateMember(groupId, memberId, patch) {
    const group = this.getGroup(groupId)
    const member = group?.members.find((item) => item.id === memberId)
    if (!member) return
    Object.assign(member, patch)
    this.#save()
  }

  /**
   * Remove a room from the list but KEEP its chat history: the transcript moves into
   * `archive/` and an index row records where it went, so nothing is lost.
   */
  archiveGroup(groupId) {
    const group = this.getGroup(groupId)
    if (!group) return null
    ensureDirs()
    const messages = this.readTranscript(groupId, 0, Number.MAX_SAFE_INTEGER).length
    const dest = path.join(storeRoot(), 'archive', `${groupId}.jsonl`)
    let moved = false
    try {
      fs.renameSync(transcriptFile(groupId), dest)
      moved = true
    } catch {
      /* the room never wrote a line */
    }
    this.state.groups = this.state.groups.filter((item) => item.id !== groupId)
    this.#save()

    const indexPath = archiveIndexFile()
    let index = []
    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
      if (Array.isArray(parsed)) index = parsed
    } catch {
      /* first archive */
    }
    const record = {
      id: group.id,
      name: group.name,
      cwd: group.cwd,
      members: group.members.length,
      messages,
      removedAt: new Date().toISOString(),
      transcript: moved ? path.basename(dest) : null,
      // Full snapshot so a restore can rebuild the room exactly, member thread ids included.
      snapshot: {
        id: group.id,
        name: group.name,
        cwd: group.cwd,
        brief: group.brief || '',
        createdAt: group.createdAt,
        members: group.members,
      },
    }
    index.push(record)
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8')
    return { groupId: group.id, name: group.name, messages, transcript: dest }
  }

  /** Put an archived room back: transcript returns to transcripts/, the snapshot to groups. */
  restoreGroup(groupId) {
    const indexPath = archiveIndexFile()
    let index
    try {
      index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    } catch {
      return null
    }
    if (!Array.isArray(index)) return null
    const at = index.findIndex((record) => record.id === groupId)
    if (at === -1) return null
    const record = index[at]

    const source = path.join(storeRoot(), 'archive', `${groupId}.jsonl`)
    try {
      if (fs.existsSync(source)) fs.renameSync(source, transcriptFile(groupId))
    } catch {
      /* transcript already gone; the room still restores */
    }

    const snapshot = record.snapshot || {
      id: record.id,
      name: record.name,
      cwd: record.cwd,
      brief: '',
      createdAt: record.removedAt,
      members: [],
    }
    if (!this.getGroup(snapshot.id)) this.state.groups.push(snapshot)
    this.#save()

    index.splice(at, 1)
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8')
    return snapshot
  }

  listArchives() {
    try {
      const parsed = JSON.parse(fs.readFileSync(archiveIndexFile(), 'utf8'))
      if (Array.isArray(parsed)) return parsed
    } catch {
      /* nothing archived yet */
    }
    return []
  }

  /** Last transcript seq for a room, read from the file tail instead of the whole log. */
  lastSeq(groupId) {
    let raw = ''
    try {
      raw = fs.readFileSync(transcriptFile(groupId), 'utf8')
    } catch {
      return 0
    }
    const lines = raw.split('\n')
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]
      if (!line.trim()) continue
      try {
        return Number(JSON.parse(line).seq) || 0
      } catch {
        continue
      }
    }
    return 0
  }

  renameGroup(groupId, name) {
    const group = this.getGroup(groupId)
    if (!group) return null
    const clean = String(name || '').trim()
    if (!clean) throw new Error('群名不能为空')
    group.name = clean
    this.#save()
    return { id: group.id, name: group.name }
  }

  /** 列表行要显示的「最近发言」：只读文件尾部，不扫全量。 */
  lastEntry(groupId) {
    let handle
    try {
      handle = fs.openSync(transcriptFile(groupId), 'r')
      const size = fs.fstatSync(handle).size
      const span = Math.min(size, 8192)
      const buffer = Buffer.alloc(span)
      fs.readSync(handle, buffer, 0, span, size - span)
      const lines = buffer.toString('utf8').split('\n').filter((line) => line.trim())
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const entry = JSON.parse(lines[index])
          return {
            author: entry.author || '',
            channel: entry.channel || null,
            ms: entry.ms ?? null,
            kind: entry.kind || 'message',
          }
        } catch {
          continue
        }
      }
    } catch {
      return null
    } finally {
      if (handle !== undefined) {
        try {
          fs.closeSync(handle)
        } catch {
          /* ignore */
        }
      }
    }
    return null
  }

  nextSeq(groupId) {
    const entries = this.readTranscript(groupId, 0, Number.MAX_SAFE_INTEGER)
    return entries.length === 0 ? 1 : entries[entries.length - 1].seq + 1
  }

  appendTranscript(groupId, entry) {
    ensureDirs()
    fs.appendFileSync(transcriptFile(groupId), `${JSON.stringify(entry)}\n`, 'utf8')
    return entry
  }

  readTranscript(groupId, since = 0, limit = 200) {
    ensureDirs()
    let raw = ''
    try {
      raw = fs.readFileSync(transcriptFile(groupId), 'utf8')
    } catch {
      return []
    }
    const out = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry.seq > since) out.push(entry)
      } catch {
        /* skip a torn trailing line */
      }
    }
    return limit >= out.length ? out : out.slice(out.length - limit)
  }
}
