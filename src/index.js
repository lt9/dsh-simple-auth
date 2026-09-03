import { renderLoginPage } from './login-page.js'
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

export const name = 'dsh-simple-auth'
export const inject = ['webServer']

const gated = new WeakSet()

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

function authorized(req, config, key) {
  const ttl = Number(config.sessionTtl) || DEFAULTS.sessionTtl
  const nowSec = Math.floor(Date.now() / 1000)
  if (verifySession(cookieValue(req.headers.cookie, config.cookieName), key, nowSec, ttl)) return 'cookie'
  const offered = bearerKey(req)
  if (offered && safeEqual(offered, key)) return 'bearer'
  return ''
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

export function apply(ctx, rawConfig) {
  const config = mergeConfig(rawConfig)
  const key = loadKey(config)
  const limiter = new RateLimiter(Number(config.failMax) || DEFAULTS.failMax, Number(config.failWindowMs) || DEFAULTS.failWindowMs)
  const webServer = ctx.webServer
  const server = webServer?.server
  if (!server) {
    throw new Error('dsh-simple-auth: webServer.server is missing; this dsh build cannot host a request gate')
  }
  const loopbackAuthority = config.rewriteLoopback === false ? '' : `127.0.0.1:${webServer.port}`

  if (!key) {
    console.error(
      '[dsh-simple-auth] no access key configured — every request is denied. Set ' +
        `${config.keyEnv || DEFAULTS.keyEnv} or config.keyFile, then restart.`
    )
  }

  const handleLoginPage = (req, res) => {
    if (key && authorized(req, config, key)) {
      redirect(res, sanitizeNext(new URL(req.url || '/', 'http://x').searchParams.get('next')))
      return
    }
    let next = '/'
    try {
      next = sanitizeNext(new URL(req.url || '/', 'http://x').searchParams.get('next'))
    } catch {
      next = '/'
    }
    const error = key ? '' : 'unconfigured'
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
    if (!key) {
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
    if (!safeEqual(offered, key)) {
      limiter.fail(ip)
      if (wantsJson(req)) json(res, 401, { error: 'unauthorized' })
      else redirect(res, '/login?error=bad&next=' + encodeURIComponent(next))
      return
    }
    limiter.reset(ip)
    const ttl = Number(config.sessionTtl) || DEFAULTS.sessionTtl
    const exp = Math.floor(Date.now() / 1000) + ttl
    const token = signSession(key, exp, ttl)
    const headers = { 'set-cookie': setCookieHeader(config, req, token, false) }
    if (wantsJson(req)) json(res, 200, { ok: true, next }, headers)
    else redirect(res, next, headers)
  }

  const handleLogout = (req, res) => {
    const headers = { 'set-cookie': setCookieHeader(config, req, '', true) }
    if (req.method === 'POST' && wantsJson(req)) json(res, 200, { ok: true }, headers)
    else redirect(res, '/login', headers)
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
    if (!key) {
      deny(req, res)
      return
    }
    if (method === 'GET' && pathname === '/' && tokenQueryCount(req) > 0) {
      rewriteLoopback(req, loopbackAuthority)
      downstream()
      return
    }
    const how = authorized(req, config, key)
    if (!how) {
      deny(req, res)
      return
    }
    rewriteLoopback(req, loopbackAuthority)
    downstream()
  }

  const onUpgrade = (req, socket, head, downstream) => {
    if (!key || !authorized(req, config, key)) {
      rejectUpgrade(socket)
      return
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
      onRequest(req, res, () => {
        for (const listener of requestListeners) listener(req, res)
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
}
