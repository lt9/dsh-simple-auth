/** In-process prompt/updateQueue lock per sessionId. Cleared on dsh restart. */
export class SessionLocks {
  constructor() {
    this.busy = new Map()
  }

  holder(sessionId) {
    return this.busy.get(sessionId) || null
  }

  tryAcquire(sessionId, userId) {
    const cur = this.busy.get(sessionId)
    if (!cur) {
      this.busy.set(sessionId, { userId, at: Date.now() })
      return true
    }
    return cur.userId === userId
  }

  release(sessionId, userId) {
    const cur = this.busy.get(sessionId)
    if (cur && cur.userId === userId) this.busy.delete(sessionId)
  }

  forceRelease(sessionId) {
    this.busy.delete(sessionId)
  }
}
