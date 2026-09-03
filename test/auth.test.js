import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mergeConfig,
  safeEqual,
  sanitizeNext,
  signSession,
  verifySession,
  RateLimiter,
  loadKey
} from '../src/auth.js'

test('mergeConfig keeps defaults and overrides keyEnv', () => {
  const c = mergeConfig({ keyEnv: 'LLAMA_API_KEY' })
  assert.equal(c.keyEnv, 'LLAMA_API_KEY')
  assert.equal(c.cookieName, 'dsh_simple_auth')
  assert.equal(c.rewriteLoopback, true)
})

test('safeEqual accepts matching strings and rejects others', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('abc', 'ab'), false)
})

test('sanitizeNext only allows same-origin relative paths', () => {
  assert.equal(sanitizeNext('/chat'), '/chat')
  assert.equal(sanitizeNext('https://evil.example/'), '/')
  assert.equal(sanitizeNext('//evil.example'), '/')
  assert.equal(sanitizeNext('/x\n/y'), '/')
})

test('session cookie round-trips until expiry', () => {
  const key = 'test-secret-key'
  const ttl = 60
  const exp = Math.floor(Date.now() / 1000) + ttl
  const token = signSession(key, exp, ttl)
  assert.equal(verifySession(token, key, exp - 1, ttl), true)
  assert.equal(verifySession(token, key, exp + 1, ttl), false)
  assert.equal(verifySession(token, 'other', exp - 1, ttl), false)
  assert.equal(verifySession('v1.1.not-a-mac', key, 0, ttl), false)
})

test('rate limiter trips after failMax hits', () => {
  const lim = new RateLimiter(3, 60_000)
  const now = 1_000_000
  assert.equal(lim.limited('1.1.1.1', now), false)
  lim.fail('1.1.1.1', now)
  lim.fail('1.1.1.1', now + 1)
  lim.fail('1.1.1.1', now + 2)
  assert.equal(lim.limited('1.1.1.1', now + 3), true)
  lim.reset('1.1.1.1')
  assert.equal(lim.limited('1.1.1.1', now + 4), false)
})

test('loadKey reads from env by name', () => {
  const key = loadKey({ keyEnv: 'UNIT_KEY', keyFile: '' }, { UNIT_KEY: '  hello  ' })
  assert.equal(key, 'hello')
})
