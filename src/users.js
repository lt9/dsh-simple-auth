import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { safeEqual } from './auth.js'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function authDataDir(config) {
  const custom = String(config.authDir || '').trim()
  if (custom) return custom
  return join(dshHome(), 'simple-auth')
}

export function defaultPaths(config) {
  const dir = authDataDir(config)
  return {
    dir,
    usersFile: String(config.usersFile || '').trim() || join(dir, 'users.json'),
    aclFile: String(config.aclFile || '').trim() || join(dir, 'acl.json'),
    secretFile: String(config.secretFile || '').trim() || join(dir, 'secret')
  }
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

export function readSecret(secretFile) {
  try {
    const buf = readFileSync(secretFile)
    if (buf.length >= 16) return buf
  } catch {
    /* create below */
  }
  ensureDir(join(secretFile, '..'))
  const buf = randomBytes(32)
  writeFileSync(secretFile, buf, { mode: 0o600 })
  return buf
}

function resolveKeyRef(user, env = process.env) {
  if (user.key) return String(user.key).trim()
  if (user.keyFile) {
    try {
      const text = readFileSync(user.keyFile, 'utf8')
      const line = text.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#'))
      return line ? line.trim() : ''
    } catch {
      return ''
    }
  }
  if (user.keyEnv) return String(env[user.keyEnv] || '').trim()
  return ''
}

export function loadUsers(usersFile, env = process.env) {
  if (!usersFile || !existsSync(usersFile)) return []
  const raw = JSON.parse(readFileSync(usersFile, 'utf8'))
  const list = Array.isArray(raw) ? raw : raw.users
  if (!Array.isArray(list)) return []
  return list
    .map((u) => ({
      id: String(u.id || '').trim(),
      name: String(u.name || u.id || '').trim(),
      key: resolveKeyRef(u, env)
    }))
    .filter((u) => u.id && u.key)
}

export function matchUserByKey(users, offered) {
  if (!offered) return null
  for (const user of users) {
    if (safeEqual(offered, user.key)) return user
  }
  return null
}

export function findUser(users, userId) {
  return users.find((u) => u.id === userId) || null
}

export function publicUsers(users) {
  return users.map((u) => ({ id: u.id, name: u.name }))
}

/** v2 cookie: v2.<uidB64>.<exp>.<mac> */
export function signUserCookie(secret, userId, exp, ttl) {
  const uid = Buffer.from(String(userId), 'utf8').toString('base64url')
  const mac = createHmac('sha256', secret).update(`v2|${userId}|${exp}|${ttl}`).digest('base64url')
  return `v2.${uid}.${exp}.${mac}`
}

export function verifyUserCookie(secret, token, nowSec, ttl) {
  if (!token || !secret) return ''
  const parts = String(token).split('.')
  if (parts.length !== 4 || parts[0] !== 'v2') return ''
  let userId = ''
  try {
    userId = Buffer.from(parts[1], 'base64url').toString('utf8')
  } catch {
    return ''
  }
  const exp = Number(parts[2])
  if (!userId || !Number.isFinite(exp) || exp < nowSec) return ''
  const expected = createHmac('sha256', secret).update(`v2|${userId}|${exp}|${ttl}`).digest('base64url')
  const got = parts[3]
  if (got.length !== expected.length) return ''
  if (!timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return ''
  return userId
}
