/**
 * Next.js instrumentation hook — runs once when the server process
 * boots (stable since Next 15, no config flag needed). Every QR-linked
 * WhatsApp session is an in-process Baileys WebSocket (see
 * src/lib/whatsapp-qr/session-manager.ts); nothing survives a
 * restart/redeploy except what's persisted to Postgres, so every
 * already-paired number needs to reconnect here rather than staying
 * silently offline until someone notices.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  // Confirmed root cause of "WhatsApp keeps disconnecting" (2026-07-31):
  // Baileys' own useMultiFileAuthState.saveCreds() rejected when a
  // reconnect briefly overlapped two sockets writing to the same
  // configId's auth folder; that one unhandled rejection crashed this
  // entire process (not just the Baileys session) by Node's default
  // behavior, restarting the whole app and every live QR/customer
  // connection with it. The direct cause is fixed (saveCreds() now has
  // a .catch() in session-manager.ts), but this is a single long-lived
  // process serving live traffic through a large third-party dependency
  // we don't fully control every code path of — logging instead of
  // crashing on any other unhandled rejection is safer than letting one
  // stray promise anywhere take the whole server down.
  process.on('unhandledRejection', (reason) => {
    console.error('[process] unhandled rejection (continuing, not crashing):', reason)
  })

  const { reconnectAllQrSessions, startQrWatchdog } = await import('@/lib/whatsapp-qr/session-manager')
  reconnectAllQrSessions().catch((err) =>
    console.error('[instrumentation] QR session reconnect sweep failed:', err),
  )
  // Boot sweep above is a single attempt — the watchdog re-runs the same
  // idempotent sweep every few minutes so a session stuck offline (failed
  // reconnect, missed close event, etc.) recovers on its own instead of
  // staying dead until someone notices and redeploys.
  startQrWatchdog()
}
