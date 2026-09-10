/**
 * Host-plane adapters that differ across dsh releases.
 *
 * 0.1.1-rc.2 and 0.1.2-rc.1 both provide `ctx.webServer` (`super(ctx, "webServer")`).
 * Later alphas discussed an `httpServer` rename; resolve both.
 *
 * 0.1.2-rc.1 adds `connection.authorizeIndex` / `requestRejection` (browser-session
 * cookie + launch token). Our login cookie already gates the process, so an
 * authenticated request must not be bounced with 401 by that second fence.
 */

export function resolveWebServer(ctx) {
  if (!ctx || typeof ctx !== 'object') return null
  return ctx.webServer || ctx.httpServer || null
}

export function wrapConnectionBrowserAuth(ctx, isAuthenticatedRequest) {
  if (!ctx || typeof ctx.inject !== 'function') return
  ctx.inject(['connection'], (scoped) => {
    const conn = scoped?.connection
    if (!conn) return

    if (typeof conn.authorizeIndex === 'function') {
      const orig = conn.authorizeIndex.bind(conn)
      conn.authorizeIndex = (req, res) => {
        if (isAuthenticatedRequest(req)) return true
        return orig(req, res)
      }
    }

    if (typeof conn.requestRejection === 'function') {
      const orig = conn.requestRejection.bind(conn)
      conn.requestRejection = (req) => {
        const code = orig(req)
        if (code === 401 && isAuthenticatedRequest(req)) return undefined
        return code
      }
    }
  })
}
