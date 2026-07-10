import { Boom } from '@hapi/boom'
import pino from 'pino'
import makeWASocket, {
  // Aliased — its name starts with "use", which trips the
  // react-hooks/rules-of-hooks lint rule even though this is a plain
  // async function, not a React hook.
  useMultiFileAuthState as loadMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  type WASocket,
} from 'baileys'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { authFolderPath, restoreAuthFolder, scheduleAuthSnapshot, clearAuthFolder } from './auth-store'
import { jidToPhone } from './jid'
import { handleInboundBaileysMessage } from './inbound'

const logger = pino({ level: 'silent' })

interface SessionEntry {
  sock: WASocket
  accountId: string
  configOwnerUserId: string
}

// Module-scope — lives for the process's lifetime. There is exactly one
// Next.js process for this app (see instrumentation.ts, which reconnects
// every 'qr' config's session on boot), so this is the single source of
// truth for "which QR sessions are live right now".
const sessions = new Map<string, SessionEntry>()

export function getSession(configId: string): WASocket | undefined {
  return sessions.get(configId)?.sock
}

export function isConnected(configId: string): boolean {
  return sessions.has(configId)
}

/**
 * Start (or resume) a QR-linked WhatsApp session for one whatsapp_config
 * row. Safe to call repeatedly — a no-op if already running. Persists
 * connection state + the live pairing QR to `whatsapp_qr_sessions` so the
 * settings UI can poll it, and reconnects automatically on any
 * disconnect that isn't an explicit logout.
 */
export async function startSession(
  configId: string,
  accountId: string,
  configOwnerUserId: string,
): Promise<void> {
  if (sessions.has(configId)) return

  const folder = authFolderPath(configId)
  await restoreAuthFolder(configId)

  const { state, saveCreds } = await loadMultiFileAuthState(folder)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    auth: state,
    version,
    logger,
    // Testing-volume connections only — presenting as a normal WhatsApp
    // Web session (rather than a named "bot" browser) is part of the
    // same ban-risk-minimization goal as the send pacing in send-queue.ts.
    browser: ['Chrome (Linux)', 'Chrome', '129.0.0.0'],
  })

  sessions.set(configId, { sock, accountId, configOwnerUserId })

  sock.ev.on('creds.update', () => {
    void saveCreds()
    scheduleAuthSnapshot(configId)
  })

  sock.ev.on('connection.update', (update) => {
    void handleConnectionUpdate(configId, accountId, configOwnerUserId, update)
  })

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      handleInboundBaileysMessage(sock, accountId, configOwnerUserId, configId, msg).catch(
        (err) => console.error('[whatsapp-qr] inbound message handling failed:', err),
      )
    }
  })
}

async function handleConnectionUpdate(
  configId: string,
  accountId: string,
  configOwnerUserId: string,
  update: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } },
): Promise<void> {
  const db = supabaseAdmin()

  if (update.qr) {
    await db
      .from('whatsapp_qr_sessions')
      .update({ status: 'qr_pending', last_qr: update.qr, updated_at: new Date().toISOString() })
      .eq('whatsapp_config_id', configId)
    return
  }

  if (update.connection === 'connecting') {
    await db
      .from('whatsapp_qr_sessions')
      .update({ status: 'connecting', updated_at: new Date().toISOString() })
      .eq('whatsapp_config_id', configId)
    return
  }

  if (update.connection === 'open') {
    const sock = sessions.get(configId)?.sock
    // Prefer the explicit phone-number field — `user.id` can be in LID
    // (linked-id) format on newer accounts, which isn't a dialable number.
    const meId = sock?.user?.phoneNumber ?? sock?.user?.id
    const linkedPhone = meId ? jidToPhone(meId) : null
    await db
      .from('whatsapp_qr_sessions')
      .update({
        status: 'connected',
        last_qr: null,
        linked_phone_number: linkedPhone,
        last_connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('whatsapp_config_id', configId)
    await db
      .from('whatsapp_config')
      .update({ status: 'connected', connected_at: new Date().toISOString() })
      .eq('id', configId)
    return
  }

  if (update.connection === 'close') {
    const statusCode = (update.lastDisconnect?.error as Boom | undefined)?.output?.statusCode
    const loggedOut = statusCode === DisconnectReason.loggedOut

    sessions.delete(configId)

    if (loggedOut) {
      await db
        .from('whatsapp_qr_sessions')
        .update({ status: 'logged_out', updated_at: new Date().toISOString() })
        .eq('whatsapp_config_id', configId)
      await db
        .from('whatsapp_config')
        .update({ status: 'disconnected' })
        .eq('id', configId)
      await clearAuthFolder(configId)
      return
    }

    await db
      .from('whatsapp_qr_sessions')
      .update({ status: 'disconnected', updated_at: new Date().toISOString() })
      .eq('whatsapp_config_id', configId)
    await db.from('whatsapp_config').update({ status: 'disconnected' }).eq('id', configId)

    // Any other close reason (connection dropped, restart requested,
    // etc.) — reconnect using the same persisted auth, no re-scan.
    void startSession(configId, accountId, configOwnerUserId).catch((err) =>
      console.error('[whatsapp-qr] reconnect failed:', err),
    )
  }
}

/** Explicit disconnect — used when the user removes a QR number from Settings. */
export async function stopSession(configId: string): Promise<void> {
  const entry = sessions.get(configId)
  sessions.delete(configId)
  if (entry) {
    try {
      await entry.sock.logout()
    } catch {
      // Best-effort — the socket may already be dead; fall through to
      // local cleanup either way.
    }
  }
  await clearAuthFolder(configId)
}

/**
 * Reconnect every already-paired QR session. Called once from
 * instrumentation.ts on process boot — a redeploy/restart otherwise
 * leaves every QR number silently disconnected until someone notices.
 */
export async function reconnectAllQrSessions(): Promise<void> {
  const db = supabaseAdmin()
  const { data: configs, error } = await db
    .from('whatsapp_config')
    .select('id, account_id, user_id')
    .eq('provider', 'qr')

  if (error) {
    console.error('[whatsapp-qr] failed to list QR configs on boot:', error.message)
    return
  }

  for (const config of configs ?? []) {
    startSession(config.id, config.account_id, config.user_id).catch((err) =>
      console.error(`[whatsapp-qr] boot reconnect failed for ${config.id}:`, err),
    )
  }
}
