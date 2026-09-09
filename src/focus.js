/** Last session a user actually opened, taken from DSH RPC/WS sessionId — not logs or UI text. */

const IGNORE_METHODS = new Set([
  'session.list',
  'session.search',
  'workspace.list',
  'workspace.create',
  'workspace.rename',
  'workspace.insertBefore',
  'host/workspace-changed',
  'host/archived-sessions-changed',
  'host/workspace-removed',
  'host/workspace-order-changed'
])

export function isFocusMethod(method) {
  const m = String(method || '')
  if (!m || IGNORE_METHODS.has(m)) return false
  if (m.startsWith('host/workspace')) return false
  return true
}

export class SessionFocus {
  constructor() {
    this.byUser = new Map()
  }

  note(userId, sessionId, method = '') {
    if (!userId || !sessionId) return
    if (!isFocusMethod(method)) return
    this.byUser.set(userId, {
      sessionId: String(sessionId),
      method: String(method || ''),
      at: Date.now()
    })
  }

  current(userId) {
    if (!userId) return null
    return this.byUser.get(userId) || null
  }

  clear(userId) {
    if (userId) this.byUser.delete(userId)
    else this.byUser.clear()
  }
}

export function catalogLabel(row) {
  if (!row || typeof row !== 'object') return ''
  return String(row.title || row.name || row.displayName || row.label || '').trim()
}

export function catalogFromList(items, userId, acl) {
  const out = []
  const seen = new Set()
  if (Array.isArray(items)) {
    for (const row of items) {
      const sessionId = row?.sessionId ? String(row.sessionId) : ''
      if (!sessionId || seen.has(sessionId) || !acl.canView(userId, sessionId)) continue
      seen.add(sessionId)
      out.push({
        sessionId,
        displayLabel: catalogLabel(row),
        blank: row.blank === true,
        cwd: row.cwd ? String(row.cwd) : '',
        canShare: acl.isOwner(userId, sessionId)
      })
    }
  }
  if (typeof acl.sharedWithUser === 'function') {
    for (const sessionId of acl.sharedWithUser(userId)) {
      if (seen.has(sessionId) || !acl.canView(userId, sessionId)) continue
      seen.add(sessionId)
      out.push({
        sessionId,
        displayLabel: '',
        blank: false,
        cwd: '',
        canShare: false
      })
    }
  }
  return out
}

export function findCatalogRow(items, sessionId) {
  if (!sessionId || !Array.isArray(items)) return null
  return items.find((row) => row && row.sessionId === sessionId) || null
}
