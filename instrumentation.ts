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

  const { reconnectAllQrSessions } = await import('@/lib/whatsapp-qr/session-manager')
  reconnectAllQrSessions().catch((err) =>
    console.error('[instrumentation] QR session reconnect sweep failed:', err),
  )
}
