import { injectBoot } from './boot.js'
import { readRequestBody } from './body.js'
import { AclStore, scanSessionsToAcl, sessionCwdFromDisk, sessionMetaFromDisk, sessionDisplayLabel } from './acl.js'
import { SessionLocks } from './locks.js'
import { createRpcGate, patchWsFrame } from './rpc-gate.js'
import { elideHistoryPayload } from './history.js'
import { renderLoginPage } from './login-page.js'
import { installWsFilter } from './ws-filter.js'
import {
  DEFAULTS,
  RateLimiter,
  bearerKey,
  clientIp,
  cookieValue,
  isHttps,
  loadKey,
  mergeConfig,
  pathnameOf,
  safeEqual,
  sanitizeNext,
  signSession,
  verifySession
} from './auth.js'
import {
  defaultPaths,
  ensureDir,
  findUser,
  loadUsers,
  matchUserByKey,
  publicUsers,
  readSecret,
  signUserCookie,
  verifyUserCookie
} from './users.js'

export const name = 'dsh-simple-auth'
export const inject = ['webServer']

const gated = new WeakSet()
const MUX_PATH = '/api/events.mux'
const HOST_PATH = '/api/events.host'

function json(res, status, body, extraHeaders) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders
  })
  res.end(text)
}

function redirect(res, location, extraHeaders) {
  res.writeHead(302, { location, 'cache-control': 'no-store', ...extraHeaders })
  res.end()
}

function setCookieHeader(config, req, token, clear) {
  const parts = clear
    ? [`${config.cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
    : [
        `${config.cookieName}=${encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Number(config.sessionTtl) || DEFAULTS.sessionTtl}`
      ]
  if (isHttps(req, config.cookieSecure)) parts.push('Secure')
  return parts.join('; ')
}

async function readBody(req, max = 16 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > max) return undefined
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseKeyFromBody(req, raw) {
  const type = String(req.headers['content-type'] || '')
  if (type.includes('application/json')) {
    try {
      const obj = JSON.parse(raw || '{}')
      return { key: String(obj.key || obj.password || '').trim(), next: sanitizeNext(obj.next) }
    } catch {
      return { key: '', next: '/' }
    }
  }
  const fields = {}
  for (const pair of String(raw).split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    try {
      const k = decodeURIComponent((eq === -1 ? pair : pair.slice(0, eq)).replaceAll('+', ' '))
      const v = decodeURIComponent((eq === -1 ? '' : pair.slice(eq + 1)).replaceAll('+', ' '))
      fields[k] = v
    } catch {
      /* malformed pair */
    }
  }
  return { key: String(fields.key || fields.password || '').trim(), next: sanitizeNext(fields.next) }
}

function wantsJson(req) {
  const accept = String(req.headers.accept || '')
  const type = String(req.headers['content-type'] || '')
  return type.includes('application/json') || accept.includes('application/json')
}

function shouldTapApi(req) {
  const method = req.method || 'GET'
  if (method !== 'POST' && method !== 'PUT') return false
  const path = pathnameOf(req)
  if (path !== '/api' && !path.startsWith('/api/')) return false
  const accept = String(req.headers.accept || '')
  if (accept.includes('text/event-stream')) return false
  return true
}

function tapJsonTransform(res, transform) {
  const chunks = []
  const origEnd = res.end.bind(res)
  const origWrite = res.write.bind(res)
  let lockSession = ''
  let lockUser = ''

  res.write = function (chunk, enc, cb) {
    if (chunk && typeof chunk !== 'function') {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8'))
    }
    if (typeof enc === 'function') enc()
    else if (typeof cb === 'function') cb()
    return true
  }
  res.end = function (chunk, enc, cb) {
    if (typeof chunk === 'function') {
      cb = chunk
      chunk = undefined
    }
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8'))
    }
    let out = Buffer.concat(chunks)
    try {
      if (out.length && (out[0] === 0x7b || out[0] === 0x5b)) {
        const parsed = JSON.parse(out.toString('utf8'))
        out = Buffer.from(JSON.stringify(transform(parsed)))
      }
    } catch {
      /* keep original */
    }
    if (lockSession && lockUser) {
      /* released in transform closure via onDone */
    }
    if (!res.headersSent) res.setHeader('content-length', String(out.length))
    const encoding = typeof enc === 'string' ? enc : undefined
    const callback = typeof cb === 'function' ? cb : typeof enc === 'function' ? enc : undefined
    return origEnd(out, encoding, callback)
  }
  return {
    origWrite,
    setLock(sessionId, userId) {
      lockSession = sessionId
      lockUser = userId
    },
    release(locks) {
      if (lockSession && lockUser) locks.release(lockSession, lockUser)
      lockSession = ''
      lockUser = ''
    }
  }
}

function rejectUpgrade(socket, status = 401, body = 'unauthorized') {
  socket.end(
    [
      `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}`,
      'Connection: close',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Length: ' + Buffer.byteLength(body),
      '',
      body
    ].join('\r\n')
  )
}

function rewriteLoopback(req, authority) {
  if (!authority) return
  req.headers.host = authority
  if (req.headers.origin) req.headers.origin = 'http://' + authority
}

function pickLang(req) {
  try {
    const q = new URL(req.url || '/', 'http://x').searchParams.get('lang')
    if (q === 'zh' || q === 'en') return q
  } catch {
    /* ignore */
  }
  const al = String(req.headers['accept-language'] || '').toLowerCase()
  return al.includes('zh') ? 'zh' : 'en'
}

function tokenQueryCount(req) {
  try {
    return new URL(req.url || '/', 'http://x').searchParams.getAll('token').length
  } catch {
    return 0
  }
}

function createAuthState(config) {
  const paths = defaultPaths(config)
  ensureDir(paths.dir)
  const users = loadUsers(paths.usersFile)
  const multiUser = users.length > 0
  const legacyKey = loadKey(config)
  const secret = multiUser ? readSecret(paths.secretFile) : null
  const legacyOwner = String(config.legacyOwner || DEFAULTS.legacyOwner).trim() || 'master'
  const acl = new AclStore(paths.aclFile, legacyOwner)
  const locks = new SessionLocks()
  const rpc = createRpcGate({
    acl,
    locks,
    legacyOwner,
    cwdOf: (sessionId) => sessionCwdFromDisk(sessionId)
  })
  if (multiUser) scanSessionsToAcl(acl, legacyOwner)
  const ready = multiUser ? users.length > 0 : Boolean(legacyKey)
  return { paths, users, multiUser, legacyKey, secret, legacyOwner, acl, locks, rpc, ready }
}

function resolveIdentity(req, config, state) {
  const ttl = Number(config.sessionTtl) || DEFAULTS.sessionTtl
  const nowSec = Math.floor(Date.now() / 1000)
  const token = cookieValue(req.headers.cookie, config.cookieName)

  if (state.multiUser) {
    const userId = verifyUserCookie(state.secret, token, nowSec, ttl)
    if (userId && findUser(state.users, userId)) return { kind: 'user', userId }
    const offered = bearerKey(req)
    const matched = matchUserByKey(state.users, offered)
    if (matched) return { kind: 'user', userId: matched.id }
    return null
  }

  if (verifySession(token, state.legacyKey, nowSec, ttl)) return { kind: 'legacy' }
  const offered = bearerKey(req)
  if (offered && safeEqual(offered, state.legacyKey)) return { kind: 'legacy' }
  return null
}

export function apply(ctx, rawConfig) {
  const config = mergeConfig(rawConfig)
  const state = createAuthState(config)
  const limiter = new RateLimiter(Number(config.failMax) || DEFAULTS.failMax, Number(config.failWindowMs) || DEFAULTS.failWindowMs)
  const webServer = ctx.webServer
  const server = webServer?.server
  if (!server) {
    throw new Error('dsh-simple-auth: webServer.server is missing; this dsh build cannot host a request gate')
  }
  const loopbackAuthority = config.rewriteLoopback === false ? '' : `127.0.0.1:${webServer.port}`

  if (!state.ready) {
    console.error(
      '[dsh-simple-auth] no access key configured — every request is denied. Set usersFile or ' +
        `${config.keyEnv || DEFAULTS.keyEnv} / config.keyFile, then restart.`
    )
  }

  const handleLoginPage = (req, res) => {
    if (state.ready && resolveIdentity(req, config, state)) {
      redirect(res, sanitizeNext(new URL(req.url || '/', 'http://x').searchParams.get('next')))
      return
    }
    let next = '/'
    try {
      next = sanitizeNext(new URL(req.url || '/', 'http://x').searchParams.get('next'))
    } catch {
      next = '/'
    }
    const error = state.ready ? '' : 'unconfigured'
    const html = renderLoginPage({
      title: config.title || DEFAULTS.title,
      hint: config.hint || '',
      next,
      error,
      remember: config.remember !== false,
      lang: pickLang(req)
    })
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; connect-src 'self'; base-uri 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    })
    res.end(html)
  }

  const handleLoginPost = async (req, res) => {
    const ip = clientIp(req)
    if (!state.ready) {
      if (wantsJson(req)) json(res, 503, { error: 'unconfigured' })
      else redirect(res, '/login?error=unconfigured')
      return
    }
    if (limiter.limited(ip)) {
      if (wantsJson(req)) json(res, 429, { error: 'too many attempts' })
      else redirect(res, '/login?error=rate')
      return
    }
    const raw = await readBody(req)
    if (raw === undefined) {
      json(res, 413, { error: 'payload too large' })
      return
    }
    const { key: offered, next } = parseKeyFromBody(req, raw)
    const ttl = Number(config.sessionTtl) || DEFAULTS.sessionTtl
    const exp = Math.floor(Date.now() / 1000) + ttl
    let token = ''
    if (state.multiUser) {
      const user = matchUserByKey(state.users, offered)
      if (!user) {
        limiter.fail(ip)
        if (wantsJson(req)) json(res, 401, { error: 'unauthorized' })
        else redirect(res, '/login?error=bad&next=' + encodeURIComponent(next))
        return
      }
      token = signUserCookie(state.secret, user.id, exp, ttl)
    } else if (!safeEqual(offered, state.legacyKey)) {
      limiter.fail(ip)
      if (wantsJson(req)) json(res, 401, { error: 'unauthorized' })
      else redirect(res, '/login?error=bad&next=' + encodeURIComponent(next))
      return
    } else {
      token = signSession(state.legacyKey, exp, ttl)
    }
    limiter.reset(ip)
    const headers = { 'set-cookie': setCookieHeader(config, req, token, false) }
    if (wantsJson(req)) json(res, 200, { ok: true, next }, headers)
    else redirect(res, next, headers)
  }

  const handleLogout = (req, res) => {
    const headers = { 'set-cookie': setCookieHeader(config, req, '', true) }
    if (req.method === 'POST' && wantsJson(req)) json(res, 200, { ok: true }, headers)
    else redirect(res, '/login', headers)
  }

  const handleSimpleAuthApi = async (req, res, pathname, identity) => {
    if (!state.multiUser) {
      json(res, 404, { error: 'not found' })
      return
    }
    const userId = identity?.userId
    if (!userId) {
      json(res, 401, { error: 'unauthorized' })
      return
    }
    if (pathname === '/simple-auth/me' && (req.method === 'GET' || req.method === 'HEAD')) {
      const user = findUser(state.users, userId)
      json(res, 200, user ? { id: user.id, name: user.name } : { id: userId, name: userId })
      return
    }
    if (pathname === '/simple-auth/users' && (req.method === 'GET' || req.method === 'HEAD')) {
      json(res, 200, publicUsers(state.users))
      return
    }
    if (pathname === '/simple-auth/sessions' && (req.method === 'GET' || req.method === 'HEAD')) {
      const items = []
      for (const sessionId of Object.keys(state.acl.data.sessions || {})) {
        if (!state.acl.canView(userId, sessionId)) continue
        const meta = sessionMetaFromDisk(sessionId)
        items.push({
          sessionId,
          displayLabel: sessionDisplayLabel(meta, sessionId),
          blank: meta.blank === true,
          canShare: state.acl.isOwner(userId, sessionId)
        })
      }
      json(res, 200, { items })
      return
    }
    if (pathname === '/simple-auth/session-acl' && (req.method === 'GET' || req.method === 'HEAD')) {
      let sessionId = ''
      try {
        sessionId = new URL(req.url || '/', 'http://x').searchParams.get('sessionId') || ''
      } catch {
        sessionId = ''
      }
      sessionId = String(sessionId).trim()
      if (!sessionId) {
        json(res, 400, { error: 'sessionId required' })
        return
      }
      if (!state.acl.canView(userId, sessionId)) {
        json(res, 403, { error: 'forbidden' })
        return
      }
      const entry = state.acl.entry(sessionId)
      const isOwner = state.acl.isOwner(userId, sessionId)
      const meta = sessionMetaFromDisk(sessionId)
      const label = sessionDisplayLabel(meta, sessionId)
      const sharedWith = isOwner ? entry?.sharedWith || [] : []
      json(res, 200, {
        owner: entry?.owner || '',
        sharedWith,
        canShare: isOwner,
        mutualAccess: !isOwner && state.acl.canView(userId, sessionId),
        displayLabel: label,
        blank: meta.blank === true
      })
      return
    }
    if ((pathname === '/simple-auth/share' || pathname === '/simple-auth/unshare') && req.method === 'POST') {
      const raw = await readBody(req, 64 * 1024)
      if (raw === undefined) {
        json(res, 413, { error: 'payload too large' })
        return
      }
      let body = {}
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        json(res, 400, { error: 'bad json' })
        return
      }
      const sessionId = String(body.sessionId || '').trim()
      const target = String(body.userId || '').trim()
      if (!sessionId || !target) {
        json(res, 400, { error: 'sessionId and userId required' })
        return
      }
      if (!state.acl.isOwner(userId, sessionId)) {
        json(res, 403, { error: 'forbidden' })
        return
      }
      const result =
        pathname === '/simple-auth/share'
          ? state.acl.share(sessionId, userId, target)
          : state.acl.unshare(sessionId, userId, target)
      if (!result.ok && result.alreadyShared) {
        json(res, 409, result)
        return
      }
      json(res, result.ok ? 200 : 403, result)
      return
    }
    json(res, 404, { error: 'not found' })
  }

  const deny = (req, res) => {
    const method = req.method || 'GET'
    if (method === 'GET' || method === 'HEAD') {
      const next = sanitizeNext(req.url)
      redirect(res, '/login?next=' + encodeURIComponent(next))
      return
    }
    json(res, 401, { error: 'unauthorized' })
  }

  const onRequest = async (req, res, downstream) => {
    const pathname = pathnameOf(req)
    const method = req.method || 'GET'

    if (pathname === '/login') {
      if (method === 'GET' || method === 'HEAD') {
        handleLoginPage(req, res)
        return
      }
      if (method === 'POST') {
        await handleLoginPost(req, res)
        return
      }
      res.writeHead(405, { allow: 'GET, HEAD, POST' })
      res.end()
      return
    }
    if (pathname === '/logout' && (method === 'GET' || method === 'POST')) {
      handleLogout(req, res)
      return
    }
    if (pathname.startsWith('/simple-auth/')) {
      const identity = resolveIdentity(req, config, state)
      if (!identity) {
        deny(req, res)
        return
      }
      await handleSimpleAuthApi(req, res, pathname, identity)
      return
    }
    if (!state.ready) {
      deny(req, res)
      return
    }
    if (method === 'GET' && pathname === '/' && tokenQueryCount(req) > 0) {
      rewriteLoopback(req, loopbackAuthority)
      downstream()
      return
    }
    const identity = resolveIdentity(req, config, state)
    if (!identity) {
      deny(req, res)
      return
    }

    if (state.multiUser && pathname === '/api/session.export' && (method === 'GET' || method === 'HEAD')) {
      try {
        const sid = new URL(req.url || '/', 'http://x').searchParams.get('sessionId') || ''
        if (sid && !state.acl.canView(identity.userId, sid)) {
          res.writeHead(403)
          res.end('forbidden')
          return
        }
      } catch {
        /* pass through */
      }
    }

    let activeReq = req
    let rpcMethod = ''
    let envelope = null
    let tap = null

    if (state.multiUser && shouldTapApi(req)) {
      rpcMethod = state.rpc.methodFromPath(pathname)
      if (rpcMethod) {
        const captured = await readRequestBody(req)
        if (captured.error) {
          json(res, 413, { error: 'payload too large' })
          return
        }
        activeReq = captured.req
        envelope = state.rpc.parseEnvelope(captured.body.toString('utf8'))
        const verdict = state.rpc.checkRequest(rpcMethod, envelope, identity.userId)
        if (!verdict.allow) {
          if (verdict.busy) {
            state.rpc.busyRpc(res, envelope?.rpcId, verdict.owner)
            return
          }
          state.rpc.denyRpc(res, envelope?.rpcId, verdict.status || 403, verdict.code || 'forbidden', 'forbidden')
          return
        }
        tap = tapJsonTransform(res, (payload) => state.rpc.onResponse(rpcMethod, envelope, identity.userId, payload))
        if (verdict.lock) tap.setLock(verdict.lock, identity.userId)
        if (verdict.release) state.locks.forceRelease(verdict.release)
        res.on('close', () => tap.release(state.locks))
        res.on('finish', () => tap.release(state.locks))
      }
    } else if (shouldTapApi(req)) {
      tap = tapJsonTransform(res, (payload) => elideHistoryPayload(payload))
    }

    rewriteLoopback(req, loopbackAuthority)
    downstream(activeReq)
  }

  const onUpgrade = (req, socket, head, downstream) => {
    if (!state.ready || !resolveIdentity(req, config, state)) {
      rejectUpgrade(socket)
      return
    }
    const pathname = pathnameOf(req)
    if (state.multiUser && (pathname === MUX_PATH || pathname === HOST_PATH)) {
      const identity = resolveIdentity(req, config, state)
      installWsFilter(socket, (obj) => patchWsFrame(obj, identity.userId, state.acl))
    }
    rewriteLoopback(req, loopbackAuthority)
    downstream()
  }

  const install = () => {
    if (gated.has(server)) return () => {}
    gated.add(server)
    const requestListeners = server.listeners('request').slice()
    const upgradeListeners = server.listeners('upgrade').slice()
    server.removeAllListeners('request')
    server.removeAllListeners('upgrade')
    server.on('request', (req, res) => {
      onRequest(req, res, (replayReq) => {
        const r = replayReq || req
        for (const listener of requestListeners) listener(r, res)
      }).catch((err) => {
        ctx.logger?.warn?.(err instanceof Error ? err : new Error(String(err)))
        if (!res.headersSent) {
          res.writeHead(400)
          res.end()
        }
      })
    })
    server.on('upgrade', (req, socket, head) => {
      onUpgrade(req, socket, head, () => {
        for (const listener of upgradeListeners) listener(req, socket, head)
      })
    })
    return () => {
      if (!gated.has(server)) return
      gated.delete(server)
      server.removeAllListeners('request')
      server.removeAllListeners('upgrade')
      for (const listener of requestListeners) server.on('request', listener)
      for (const listener of upgradeListeners) server.on('upgrade', listener)
    }
  }

  let dispose = () => {}
  const start = () => {
    dispose = install()
  }
  if (server.listening) start()
  else server.once('listening', start)
  ctx.effect(() => () => dispose(), 'dsh-simple-auth: gate')

  const minTimeout = Number(config.rpcMinTimeoutMs)
  if (typeof webServer.tapIndex === 'function') {
    ctx.effect(
      () => webServer.tapIndex((html) => injectBoot(html, minTimeout, state.multiUser)),
      'dsh-simple-auth: boot injection'
    )
  }
}
