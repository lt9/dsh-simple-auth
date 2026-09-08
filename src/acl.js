import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readdirSync, readFileSync as readSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import zlib from 'node:zlib'
import { join } from 'node:path'
import { dshHome } from './users.js'

const EMPTY = { sessions: {} }

export class AclStore {
  constructor(aclFile, legacyOwner = 'master') {
    this.aclFile = aclFile
    this.legacyOwner = legacyOwner
    this.data = { sessions: {} }
    this.load()
  }

  load() {
    if (!this.aclFile || !existsSync(this.aclFile)) {
      this.data = { sessions: {} }
      return
    }
    try {
      const raw = JSON.parse(readFileSync(this.aclFile, 'utf8'))
      this.data = raw && typeof raw === 'object' && raw.sessions ? raw : EMPTY
      if (!this.data.sessions || typeof this.data.sessions !== 'object') this.data.sessions = {}
    } catch {
      this.data = { sessions: {} }
    }
  }

  save() {
    writeFileSync(this.aclFile, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 })
  }

  entry(sessionId) {
    return this.data.sessions[sessionId] || null
  }

  ownerOf(sessionId) {
    return this.entry(sessionId)?.owner || ''
  }

  canView(userId, sessionId) {
    if (!userId || !sessionId) return false
    const e = this.entry(sessionId)
    if (!e) return false
    return e.owner === userId || (Array.isArray(e.sharedWith) && e.sharedWith.includes(userId))
  }

  isOwner(userId, sessionId) {
    return this.ownerOf(sessionId) === userId
  }

  ensureOwner(sessionId, owner) {
    if (!sessionId || !owner) return
    const e = this.entry(sessionId)
    if (e) return
    this.data.sessions[sessionId] = { owner, sharedWith: [] }
    this.save()
  }

  adoptOrphans(sessionIds, owner) {
    if (!owner || !Array.isArray(sessionIds)) return
    let changed = false
    for (const id of sessionIds) {
      if (!id || this.entry(id)) continue
      this.data.sessions[id] = { owner, sharedWith: [] }
      changed = true
    }
    if (changed) this.save()
  }

  setOwner(sessionId, owner) {
    if (!sessionId || !owner) return
    const prev = this.entry(sessionId)
    this.data.sessions[sessionId] = { owner, sharedWith: prev?.sharedWith || [] }
    this.save()
  }

  share(sessionId, ownerId, targetUserId) {
    const e = this.entry(sessionId)
    if (!e || e.owner !== ownerId) return { ok: false, error: 'forbidden' }
    if (targetUserId === ownerId) return { ok: true }
    const shared = new Set(e.sharedWith || [])
    if (shared.has(targetUserId)) {
      return { ok: false, error: 'already-shared', alreadyShared: true }
    }
    shared.add(targetUserId)
    e.sharedWith = [...shared]
    this.save()
    return { ok: true }
  }

  unshare(sessionId, ownerId, targetUserId) {
    const e = this.entry(sessionId)
    if (!e || e.owner !== ownerId) return { ok: false, error: 'forbidden' }
    const prev = e.sharedWith || []
    if (!prev.includes(targetUserId)) return { ok: true, unchanged: true }
    e.sharedWith = prev.filter((id) => id !== targetUserId)
    this.save()
    return { ok: true }
  }

  /** True when owner already granted target access to this session. */
  isSharedWith(sessionId, targetUserId) {
    const e = this.entry(sessionId)
    if (!e || !targetUserId) return false
    return Array.isArray(e.sharedWith) && e.sharedWith.includes(targetUserId)
  }

  sharedWith(sessionId) {
    return this.entry(sessionId)?.sharedWith || []
  }

  /** Session ids shared with this user (not owned by them). */
  sharedWithUser(userId) {
    if (!userId) return []
    const out = []
    for (const [sessionId, e] of Object.entries(this.data.sessions || {})) {
      if (!e || e.owner === userId) continue
      if (Array.isArray(e.sharedWith) && e.sharedWith.includes(userId)) out.push(sessionId)
    }
    return out
  }
}

/** Scan on-disk session logs and register unknown ids to legacyOwner. */
export function scanSessionsToAcl(acl, legacyOwner, root = join(dshHome(), 'sessions')) {
  if (!legacyOwner || !existsSync(root)) return 0
  const ids = new Set()
  try {
    for (const project of readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      const projectPath = join(root, project.name)
      for (const sess of readdirSync(projectPath, { withFileTypes: true })) {
        if (!sess.isDirectory()) continue
        const id = sessionIdFromDir(join(projectPath, sess.name))
        if (id) ids.add(id)
      }
    }
  } catch {
    return 0
  }
  acl.adoptOrphans([...ids], legacyOwner)
  return ids.size
}

function sessionIdFromDir(dir) {
  const dirName = join(dir).split(/[/\\]/).pop() || ''
  try {
    const head = readSessionLogFromDir(dir, 8192).split('\n')[0]
    if (head) {
      const line = JSON.parse(head)
      if (line && line.type === 'session' && line.id) return String(line.id)
    }
  } catch {
    /* fall through */
  }
  return sessionIdFromDirName(dirName)
}

function sessionIdFromDirName(name) {
  if (!name) return ''
  if (name.startsWith('session-')) return name
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) {
    return `session-${name}`
  }
  return decodeSegmentDirName(name)
}

/** Read session cwd from on-disk session log header (for workspace grouping). */
export function sessionCwdFromDisk(sessionId, root = join(dshHome(), 'sessions')) {
  const meta = sessionMetaFromDisk(sessionId, root)
  return meta.cwd || ''
}

/** Read display metadata for share UI (title / blank / cwd). */
export function sessionMetaFromDisk(sessionId, root = join(dshHome(), 'sessions')) {
  const empty = { cwd: '', title: '', blank: true }
  if (!sessionId || !existsSync(root)) return empty
  try {
    for (const project of readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      const projectPath = join(root, project.name)
      for (const sess of readdirSync(projectPath, { withFileTypes: true })) {
        if (!sess.isDirectory()) continue
        const dir = join(projectPath, sess.name)
        const id = sessionIdFromDir(dir)
        if (id !== sessionId) continue
        try {
          const text = readSessionLogFromDir(dir)
          if (text) return parseSessionLogMeta(text)
        } catch {
          /* fall through */
        }
      }
    }
  } catch {
    return empty
  }
  return empty
}

function readSessionLogFromDir(dir, maxBytes = 512 * 1024) {
  const plain = join(dir, 'session.jsonl')
  if (existsSync(plain)) {
    try {
      const text = readSync(plain, 'utf8')
      return maxBytes > 0 ? text.slice(0, maxBytes) : text
    } catch {
      /* fall through */
    }
  }
  const compressed = join(dir, 'session.jsonl.zstd')
  if (existsSync(compressed)) return decompressZstdSessionLog(compressed, maxBytes)
  return ''
}

function decompressZstdSessionLog(path, maxBytes = 512 * 1024) {
  const cap = Math.max(8192, maxBytes || 512 * 1024)
  const quoted = path.replace(/'/g, "'\\''")
  // DSH appends one zstd frame per event; Node zlib only decompresses the first frame.
  for (const shellCmd of [
    `zstdcat '${quoted}' 2>/dev/null | head -c ${cap}`,
    `zstd -d -c '${quoted}' 2>/dev/null | head -c ${cap}`
  ]) {
    const r = spawnSync('sh', ['-c', shellCmd], { encoding: 'utf8', maxBuffer: cap + 65536 })
    if (r.stdout) return String(r.stdout).slice(0, cap)
  }
  try {
    if (typeof zlib.zstdDecompressSync === 'function') {
      const text = zlib.zstdDecompressSync(readSync(path)).toString('utf8')
      return text.slice(0, cap)
    }
  } catch {
    /* fall through */
  }
  return ''
}

const SESSION_LOG_META_ONLY = new Set([
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'request/header',
  'request/context',
  'session/title-llm-request'
])

function parseSessionLogMeta(text) {
  const meta = { cwd: '', title: '', blank: true }
  const lines = String(text || '').split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const ev = row.event && typeof row.event === 'object' ? row.event : row
    const type = ev?.type
    if (!type) continue

    if (type === 'session') {
      const cwd = ev.cwd || ev.header?.cwd
      if (cwd) meta.cwd = String(cwd)
      continue
    }
    if (type === 'session/title' && ev.data?.title) {
      meta.title = String(ev.data.title).trim()
      meta.blank = false
    }
    if (type === 'turn/start' || type === 'step/start' || type === 'assistant/chunk') meta.blank = false
    if (type === 'user/message' && ev.data?.source?.kind === 'user') meta.blank = false
    if (type === 'agent/inbox/spliced' && Array.isArray(ev.data?.inserted)) {
      for (const msg of ev.data.inserted) {
        if (msg?.source?.kind === 'user') {
          meta.blank = false
          break
        }
      }
    }
    if (!meta.blank && meta.title) break
    if (!meta.blank) continue
    if (!SESSION_LOG_META_ONLY.has(type) && type !== 'session') meta.blank = false
    if (!meta.blank && meta.title) break
  }
  return meta
}

export function sessionDisplayLabel(meta, sessionId) {
  if (!meta || meta.blank) return '新会话'
  if (meta.title) return meta.title
  if (meta.cwd) {
    const base = meta.cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
    if (base) return base
  }
  return '未命名会话'
}

function decodeSegmentDirName(encoded) {
  if (!encoded || encoded === '.' || encoded === '..') return ''
  let out = ''
  for (let i = 0; i < encoded.length; i++) {
    const ch = encoded[i]
    if (ch === '~' && i + 4 < encoded.length) {
      const hex = encoded.slice(i + 1, i + 5)
      if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16))
        i += 4
        continue
      }
    }
    out += ch
  }
  return out.startsWith('session-') ? out : ''
}
