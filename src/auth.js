import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const DEFAULTS = {
  keyEnv: 'DSH_SIMPLE_AUTH_KEY',
  keyFile: '',
  usersFile: '',
  aclFile: '',
  secretFile: '',
  authDir: '',
  legacyOwner: 'master',
  cookieName: 'dsh_simple_auth',
  sessionTtl: 604800,
  cookieSecure: 'auto',
  rewriteLoopback: true,
  title: 'DeepSeek Harness',
  hint: '',
  remember: true,
  failMax: 8,
  failWindowMs: 15 * 60 * 1000,
  rpcMinTimeoutMs: 120000
}

export function mergeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return { ...DEFAULTS, ...src }
}

export function loadKey(config, env = process.env) {
  const file = String(config.keyFile || '').trim()
  if (file) {
    try {
      const text = readFileSync(file, 'utf8').trim()
      if (text) return text
    } catch {
      return ''
    }
  }
  const name = String(config.keyEnv || DEFAULTS.keyEnv).trim() || DEFAULTS.keyEnv
  return String(env[name] || '').trim()
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8')
  const right = Buffer.from(String(b), 'utf8')
  if (left.length !== right.length) {
    timingSafeEqual(createHmac('sha256', 'x').update(left).digest(), createHmac('sha256', 'x').update(right).digest())
    return false
  }
  return timingSafeEqual(left, right)
}

export function signSession(key, exp, ttl) {
  const mac = createHmac('sha256', key).update(`v1|${exp}|${ttl}`).digest('base64url')
  return `v1.${exp}.${mac}`
}

export function verifySession(token, key, nowSec, ttl) {
  if (!token || !key) return false
  const parts = String(token).split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return false
  const exp = Number(parts[1])
  if (!Number.isFinite(exp) || exp < nowSec) return false
  const expected = createHmac('sha256', key).update(`v1|${exp}|${ttl}`).digest('base64url')
  const got = parts[2]
  if (got.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected))
}

export function cookieValue(header, name) {
  if (!header) return ''
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return ''
}

export function bearerKey(req) {
  const hdr = String(req.headers.authorization || '')
  if (hdr.toLowerCase().startsWith('bearer ')) return hdr.slice(7).trim()
  return String(req.headers['x-api-key'] || '').trim()
}

export function clientIp(req) {
  const direct = req.socket?.remoteAddress || 'unknown'
  const loopback = direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1'
  if (loopback) {
    const xff = req.headers['x-forwarded-for']
    if (typeof xff === 'string') {
      const first = xff.split(',')[0]?.trim()
      if (first) return first
    }
  }
  return direct
}

export function isHttps(req, cookieSecure) {
  if (cookieSecure === true || cookieSecure === 'true') return true
  if (cookieSecure === false || cookieSecure === 'false') return false
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
  return proto === 'https'
}

export function sanitizeNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/'
  if (value.includes('\\') || value.includes('\n') || value.includes('\r')) return '/'
  return value
}

export function pathnameOf(req) {
  try {
    return new URL(req.url || '/', 'http://x').pathname
  } catch {
    return '/'
  }
}

export class RateLimiter {
  constructor(max = DEFAULTS.failMax, windowMs = DEFAULTS.failWindowMs) {
    this.max = max
    this.windowMs = windowMs
    this.hits = new Map()
  }

  _trim(ip, now) {
    const arr = (this.hits.get(ip) || []).filter((t) => now - t < this.windowMs)
    this.hits.set(ip, arr)
    return arr
  }

  limited(ip, now = Date.now()) {
    return this._trim(ip, now).length >= this.max
  }

  fail(ip, now = Date.now()) {
    const arr = this._trim(ip, now)
    arr.push(now)
    this.hits.set(ip, arr)
  }

  reset(ip) {
    this.hits.delete(ip)
  }
}

export function randomNonce() {
  return randomBytes(16).toString('base64url')
}
