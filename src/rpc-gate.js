import { elideHistoryPayload } from './history.js'

const VIEW_METHODS = new Set([
  'session.history',
  'session.prompt',
  'session.attachment',
  'session.models',
  'session.selectModel',
  'session.updateQueue',
  'session.cancel',
  'session.export',
  'skills.list',
  'subagents.list',
  'subagents.history',
  'subagents.prompt',
  'subagents.interrupt',
  'agentPresets.list',
  'agentPresets.select',
  'agentPresets.read',
  'agentPresets.openDocument'
])

const OWNER_METHODS = new Set(['session.rename', 'session.fork', 'workspace.archiveSession', 'workspace.delete'])

const LOCK_METHODS = new Set(['session.prompt', 'session.updateQueue'])

function rpcMethodFromPath(pathname) {
  if (!pathname.startsWith('/api/')) return ''
  const seg = pathname.slice(5)
  if (!seg || seg.includes('/')) return ''
  return seg
}

function parseEnvelope(bodyText) {
  try {
    const msg = JSON.parse(bodyText || '{}')
    if (!msg || typeof msg !== 'object') return null
    return msg
  } catch {
    return null
  }
}

function sessionIdFromPayload(method, payload) {
  if (!payload || typeof payload !== 'object') return ''
  if (payload.sessionId) return String(payload.sessionId)
  if (payload.parentSessionId) return String(payload.parentSessionId)
  if (method === 'workspace.archiveSession' && payload.sessionId) return String(payload.sessionId)
  return ''
}

/** All session ids implicated by a request (parent + child for subagents). */
function sessionIdsFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return []
  const ids = []
  if (payload.sessionId) ids.push(String(payload.sessionId))
  if (payload.parentSessionId) ids.push(String(payload.parentSessionId))
  if (payload.childSessionId) ids.push(String(payload.childSessionId))
  return ids
}

function filterListItems(items, userId, acl) {
  if (!Array.isArray(items)) return items
  return items.filter((row) => row && acl.canView(userId, row.sessionId))
}

function cwdMatchesWorkspace(cwd, workspacePath) {
  if (!cwd || !workspacePath) return false
  const a = String(cwd).replace(/\/+$/, '')
  const b = String(workspacePath).replace(/\/+$/, '')
  return a === b
}

function filterWorkspaceList(value, userId, acl, sessionItems = [], cwdOf) {
  if (!value || typeof value !== 'object') return value
  const items = Array.isArray(value.items)
    ? value.items.map((ws) => {
        if (!ws || !Array.isArray(ws.sessionIds)) return ws
        const ids = new Set(ws.sessionIds.filter((id) => acl.canView(userId, id)))
        for (const row of sessionItems) {
          const sid = row?.sessionId
          if (!sid || ids.has(sid) || !acl.canView(userId, sid)) continue
          if (cwdMatchesWorkspace(row.cwd, ws.path)) ids.add(sid)
        }
        if (typeof cwdOf === 'function' && typeof acl.sharedWithUser === 'function') {
          for (const sid of acl.sharedWithUser(userId)) {
            if (ids.has(sid) || !acl.canView(userId, sid)) continue
            const cwd = cwdOf(sid)
            if (cwd && cwdMatchesWorkspace(cwd, ws.path)) ids.add(sid)
          }
        }
        return { ...ws, sessionIds: [...ids] }
      })
    : value.items
  const archived = Array.isArray(value.archivedSessionIds)
    ? value.archivedSessionIds.filter((id) => acl.canView(userId, id))
    : value.archivedSessionIds
  return { ...value, items, archivedSessionIds: archived }
}

/** Last session.list items per user — used to align workspace.list grouping. */
const sessionListCache = new Map()

export function clearSessionListCache(userId) {
  if (userId) sessionListCache.delete(userId)
  else sessionListCache.clear()
}

function patchResponse(method, payload, userId, acl, legacyOwner, cwdOf) {
  if (!payload || typeof payload !== 'object') return payload
  if (!payload.result || !payload.result.ok || !payload.result.value) return elideHistoryPayload(payload)

  const value = payload.result.value
  let nextValue = value

  if (method === 'session.list' && Array.isArray(value.items)) {
    const ids = value.items.map((row) => row?.sessionId).filter(Boolean)
    acl.adoptOrphans(ids, legacyOwner)
    nextValue = { ...value, items: filterListItems(value.items, userId, acl) }
  } else if (method === 'session.search' && Array.isArray(value.items)) {
    nextValue = { ...value, items: filterListItems(value.items, userId, acl) }
  } else if (method === 'workspace.list') {
    nextValue = filterWorkspaceList(value, userId, acl, sessionListCache.get(userId) || [], cwdOf)
  }

  if (nextValue === value) return elideHistoryPayload(payload)
  return elideHistoryPayload({ ...payload, result: { ...payload.result, value: nextValue } })
}

function denyRpc(res, rpcId, status, code, message, extra) {
  const body = {
    type: 'server-response',
    rpcId: rpcId || 'denied',
    result: {
      ok: false,
      error: { code, message, details: extra || {} }
    }
  }
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(text))
  })
  res.end(text)
}

function busyRpc(res, rpcId, owner) {
  denyRpc(res, rpcId, 409, 'session-busy', 'session is busy', { owner })
}

export function createRpcGate({ acl, locks, legacyOwner, cwdOf }) {
  return {
    methodFromPath: rpcMethodFromPath,
    parseEnvelope,
    sessionIdFromPayload,

    checkRequest(method, envelope, userId) {
      const payload = envelope?.payload
      const sessionId = sessionIdFromPayload(method, payload)

      if (method === 'session.create') return { allow: true }
      if (method === 'session.list' || method === 'session.search') return { allow: true }
      if (method === 'workspace.list' || method === 'workspace.create' || method === 'workspace.rename') {
        return { allow: true }
      }
      if (method === 'workspace.insertBefore' || method === 'workspace.insertSessionBefore') {
        if (sessionId && !acl.canView(userId, sessionId)) return { allow: false, status: 403, code: 'forbidden' }
        return { allow: true }
      }

      if (OWNER_METHODS.has(method)) {
        if (!sessionId || !acl.isOwner(userId, sessionId)) {
          return { allow: false, status: 403, code: 'forbidden' }
        }
        return { allow: true }
      }

      if (VIEW_METHODS.has(method)) {
        const ids = sessionIdsFromPayload(payload)
        const checkIds = ids.length ? ids : sessionId ? [sessionId] : []
        if (!checkIds.length) {
          return { allow: false, status: 403, code: 'forbidden' }
        }
        for (const sid of checkIds) {
          if (!acl.canView(userId, sid)) {
            return { allow: false, status: 403, code: 'forbidden' }
          }
        }
        const lockId = sessionId || payload?.sessionId || payload?.parentSessionId || ''
        if (LOCK_METHODS.has(method)) {
          if (!locks.tryAcquire(lockId, userId)) {
            const owner = acl.ownerOf(lockId) || locks.holder(lockId)?.userId || ''
            return { allow: false, busy: true, owner }
          }
          return { allow: true, lock: lockId }
        }
        if (method === 'session.cancel') {
          return { allow: true, release: lockId }
        }
        return { allow: true }
      }

      return { allow: true }
    },

    onResponse(method, envelope, userId, rawPayload) {
      if (method === 'session.create') {
        const sid = rawPayload?.result?.value?.sessionId
        if (rawPayload?.result?.ok && sid) acl.setOwner(String(sid), userId)
      }
      if (method === 'session.fork') {
        const sid = rawPayload?.result?.value?.sessionId
        if (rawPayload?.result?.ok && sid) acl.setOwner(String(sid), userId)
      }
      const patched = patchResponse(method, rawPayload, userId, acl, legacyOwner, cwdOf)
      if (method === 'session.list' && patched?.result?.ok && Array.isArray(patched?.result?.value?.items)) {
        sessionListCache.set(userId, patched.result.value.items)
      }
      return patched
    },

    denyRpc,
    busyRpc,

    releaseLock(sessionId, userId) {
      if (sessionId) locks.release(sessionId, userId)
    }
  }
}

export function extractSessionIdFromFrame(obj) {
  if (!obj || typeof obj !== 'object') return ''
  const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : obj
  if (payload.sessionId) return String(payload.sessionId)
  if (obj.method && typeof obj.method === 'string') {
    const inner = payload
    if (inner && inner.sessionId) return String(inner.sessionId)
  }
  if (Array.isArray(payload.archivedSessionIds)) return '__archive__'
  return ''
}

function frameType(obj) {
  if (!obj || typeof obj !== 'object') return ''
  const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : obj
  return String(obj.method || payload.type || obj.type || '')
}

function wrapFrame(obj, nextPayload) {
  if (obj.payload && typeof obj.payload === 'object') return { ...obj, payload: nextPayload }
  return nextPayload
}

/** Patch or drop one server→client WebSocket JSON frame for multi-user ACL. */
export function patchWsFrame(obj, userId, acl) {
  if (!obj || typeof obj !== 'object') return null
  const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : obj
  const type = frameType(obj)

  if (type === 'host/workspace-changed' && payload.workspace && typeof payload.workspace === 'object') {
    const ws = payload.workspace
    const sessionIds = Array.isArray(ws.sessionIds)
      ? ws.sessionIds.filter((id) => acl.canView(userId, id))
      : ws.sessionIds
    return wrapFrame(obj, { ...payload, workspace: { ...ws, sessionIds } })
  }

  if (type === 'host/archived-sessions-changed' && Array.isArray(payload.archivedSessionIds)) {
    return wrapFrame(obj, {
      ...payload,
      archivedSessionIds: payload.archivedSessionIds.filter((id) => acl.canView(userId, id))
    })
  }

  if (type === 'host/workspace-removed' || type === 'host/workspace-order-changed') {
    return obj
  }

  const sessionId = extractSessionIdFromFrame(obj)
  if (sessionId && sessionId !== '__archive__' && !acl.canView(userId, sessionId)) return null
  return obj
}

export function frameVisible(obj, userId, acl) {
  return patchWsFrame(obj, userId, acl) !== null
}
