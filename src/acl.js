import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readdirSync, readFileSync as readSync } from 'node:fs'
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
  for (const name of ['session.jsonl', 'session.jsonl.zstd']) {
    const path = join(dir, name)
    if (!existsSync(path)) continue
    if (name.endsWith('.zstd')) continue
    try {
      const head = readSync(path, 'utf8').split('\n')[0]
      const line = JSON.parse(head)
      if (line && line.type === 'session' && line.id) return String(line.id)
    } catch {
      /* fall through */
    }
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
        for (const name of ['session.jsonl', 'session.jsonl.zstd']) {
          const path = join(dir, name)
          if (!existsSync(path) || name.endsWith('.zstd')) continue
          try {
            return parseSessionLogMeta(readSync(path, 'utf8'))
          } catch {
            /* fall through */
          }
        }
      }
    }
  } catch {
    return empty
  }
  return empty
}

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
    if (row.type === 'session' && row.header) {
      if (row.header.cwd) meta.cwd = String(row.header.cwd)
      continue
    }
    const ev = row.event || row
    if (!ev || typeof ev !== 'object') continue
    if (ev.type === 'turn/start') meta.blank = false
    if (ev.type === 'user/message' && ev.data?.source?.kind === 'user') meta.blank = false
    if (ev.type === 'session/title' && ev.data?.title) {
      meta.title = String(ev.data.title).trim()
      meta.blank = false
    }
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
