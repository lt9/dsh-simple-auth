import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  mergeConfig,
  safeEqual,
  sanitizeNext,
  signSession,
  verifySession,
  RateLimiter,
  loadKey
} from '../src/auth.js'
import { AclStore } from '../src/acl.js'
import { SessionLocks } from '../src/locks.js'
import { createRpcGate, frameVisible, patchWsFrame } from '../src/rpc-gate.js'
import {
  loadUsers,
  matchUserByKey,
  signUserCookie,
  verifyUserCookie
} from '../src/users.js'

test('mergeConfig keeps defaults and overrides keyEnv', () => {
  const c = mergeConfig({ keyEnv: 'LLAMA_API_KEY' })
  assert.equal(c.keyEnv, 'LLAMA_API_KEY')
  assert.equal(c.legacyOwner, 'master')
})

test('safeEqual accepts matching strings and rejects others', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
})

test('sanitizeNext only allows same-origin relative paths', () => {
  assert.equal(sanitizeNext('/chat'), '/chat')
  assert.equal(sanitizeNext('https://evil.example/'), '/')
})

test('session cookie round-trips until expiry', () => {
  const key = 'test-secret-key'
  const ttl = 60
  const exp = Math.floor(Date.now() / 1000) + ttl
  const token = signSession(key, exp, ttl)
  assert.equal(verifySession(token, key, exp - 1, ttl), true)
  assert.equal(verifySession(token, key, exp + 1, ttl), false)
})

test('v2 user cookie round-trips', () => {
  const secret = Buffer.from('super-secret-hmac-key-32bytes!!')
  const ttl = 3600
  const exp = Math.floor(Date.now() / 1000) + ttl
  const token = signUserCookie(secret, 'master', exp, ttl)
  assert.equal(verifyUserCookie(secret, token, exp - 1, ttl), 'master')
  assert.equal(verifyUserCookie(secret, token, exp + 1, ttl), '')
})

test('loadUsers reads json array', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sa-'))
  const file = join(dir, 'users.json')
  writeFileSync(file, JSON.stringify([{ id: 'a', name: 'A', key: 'k1' }]))
  const users = loadUsers(file)
  assert.equal(users.length, 1)
  assert.equal(users[0].id, 'a')
  assert.equal(matchUserByKey(users, 'k1')?.id, 'a')
})

test('acl owner share and view', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sa-'))
  const file = join(dir, 'acl.json')
  const acl = new AclStore(file, 'master')
  acl.setOwner('session-1', 'master')
  assert.equal(acl.canView('master', 'session-1'), true)
  assert.equal(acl.canView('guest', 'session-1'), false)
  acl.share('session-1', 'master', 'guest')
  assert.equal(acl.canView('guest', 'session-1'), true)
  assert.equal(acl.isOwner('guest', 'session-1'), false)
})

test('rpc gate filters session.list items', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sa-'))
  const acl = new AclStore(join(dir, 'acl.json'), 'master')
  acl.setOwner('session-1', 'master')
  acl.setOwner('session-2', 'guest')
  const locks = new SessionLocks()
  const gate = createRpcGate({ acl, locks, legacyOwner: 'master' })
  const out = gate.onResponse(
    'session.list',
    {},
    'master',
    {
      result: {
        ok: true,
        value: {
          items: [{ sessionId: 'session-1' }, { sessionId: 'session-2' }]
        }
      }
    }
  )
  assert.equal(out.result.value.items.length, 1)
  assert.equal(out.result.value.items[0].sessionId, 'session-1')
})

test('session lock rejects second user', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sa-'))
  const acl = new AclStore(join(dir, 'acl.json'), 'master')
  acl.setOwner('session-9', 'master')
  acl.share('session-9', 'master', 'guest')
  const locks = new SessionLocks()
  const gate = createRpcGate({ acl, locks, legacyOwner: 'master' })
  const env = { rpcId: '1', payload: { sessionId: 'session-9' } }
  const a = gate.checkRequest('session.prompt', env, 'master')
  assert.equal(a.allow, true)
  const b = gate.checkRequest('session.prompt', env, 'guest')
  assert.equal(b.allow, false)
  assert.equal(b.busy, true)
})

test('frameVisible respects acl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sa-'))
  const acl = new AclStore(join(dir, 'acl.json'), 'master')
  acl.setOwner('session-3', 'master')
  const frame = {
    payload: {
      type: 'session/event',
      sessionId: 'session-3',
      event: {}
    }
  }
  assert.equal(frameVisible(frame, 'master', acl), true)
  assert.equal(frameVisible(frame, 'guest', acl), false)
})

test('patchWsFrame filters workspace sessionIds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sa-'))
  const acl = new AclStore(join(dir, 'acl.json'), 'master')
  acl.setOwner('session-1', 'master')
  acl.setOwner('session-2', 'guest')
  acl.share('session-1', 'master', 'guest')
  const frame = {
    rpcId: 'x',
    payload: {
      type: 'host/workspace-changed',
      workspace: {
        workspaceId: 'ws-1',
        path: '/llama',
        title: 'llama',
        sessionIds: ['session-1', 'session-2', 'session-secret'],
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z'
      }
    }
  }
  const out = patchWsFrame(frame, 'guest', acl)
  assert.equal(out.payload.workspace.sessionIds.includes('session-1'), true)
  assert.equal(out.payload.workspace.sessionIds.includes('session-2'), true)
  assert.equal(out.payload.workspace.sessionIds.includes('session-secret'), false)
})

test('guest can read session-acl for shared session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sa-'))
  const acl = new AclStore(join(dir, 'acl.json'), 'master')
  acl.setOwner('session-shared', 'master')
  acl.share('session-shared', 'master', 'guest')
  assert.equal(acl.canView('guest', 'session-shared'), true)
  assert.equal(acl.isOwner('guest', 'session-shared'), false)
})

test('guest can invoke session.history on shared session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sa-'))
  const acl = new AclStore(join(dir, 'acl.json'), 'master')
  acl.setOwner('session-shared', 'master')
  acl.share('session-shared', 'master', 'guest')
  const locks = new SessionLocks()
  const gate = createRpcGate({ acl, locks, legacyOwner: 'master' })
  const env = { rpcId: '1', payload: { sessionId: 'session-shared' } }
  const verdict = gate.checkRequest('session.history', env, 'guest')
  assert.equal(verdict.allow, true)
})

test('skills.list requires session view permission', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sa-'))
  const acl = new AclStore(join(dir, 'acl.json'), 'master')
  acl.setOwner('session-1', 'master')
  const locks = new SessionLocks()
  const gate = createRpcGate({ acl, locks, legacyOwner: 'master' })
  const denied = gate.checkRequest('skills.list', { payload: { sessionId: 'session-1' } }, 'guest')
  assert.equal(denied.allow, false)
  acl.share('session-1', 'master', 'guest')
  const allowed = gate.checkRequest('skills.list', { payload: { sessionId: 'session-1' } }, 'guest')
  assert.equal(allowed.allow, true)
})

test('workspace.list attaches shared sessions by cwd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sa-'))
  const acl = new AclStore(join(dir, 'acl.json'), 'master')
  acl.setOwner('session-shared', 'master')
  acl.share('session-shared', 'master', 'guest')
  const locks = new SessionLocks()
  const gate = createRpcGate({
    acl,
    locks,
    legacyOwner: 'master',
    cwdOf: (id) => (id === 'session-shared' ? '/home/twan/llama' : '')
  })
  gate.onResponse(
    'session.list',
    {},
    'guest',
    {
      result: {
        ok: true,
        value: {
          items: [{ sessionId: 'session-shared', cwd: '/home/twan/llama', blank: false }]
        }
      }
    }
  )
  const out = gate.onResponse(
    'workspace.list',
    {},
    'guest',
    {
      result: {
        ok: true,
        value: {
          items: [
            {
              workspaceId: 'ws-llama',
              path: '/home/twan/llama',
              title: 'llama',
              sessionIds: [],
              createdAt: '2020-01-01T00:00:00.000Z',
              updatedAt: '2020-01-01T00:00:00.000Z'
            }
          ],
          archivedSessionIds: []
        }
      }
    }
  )
  assert.equal(out.result.value.items[0].sessionIds.includes('session-shared'), true)
})

test('elideHistoryPayload drops closed-message chunks', async () => {
  const { elideHistoryPayload } = await import('../src/history.js')
  const payload = {
    result: {
      ok: true,
      value: {
        events: [
          { event: { type: 'assistant/chunk', data: { turn: 1, step: 0, text: 'a' } } },
          { event: { type: 'assistant/message', data: { turn: 1, step: 0, text: 'ab' } } }
        ]
      }
    }
  }
  const out = elideHistoryPayload(payload)
  assert.equal(out.result.value.events.length, 1)
})
