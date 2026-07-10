import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

/**
 * Baileys' own `useMultiFileAuthState` (see its jsdoc) explicitly says
 * it's not meant for production use beyond a small bot — it just writes
 * one JSON file per signal key to a folder. We keep using it as-is (it's
 * battle-tested and correct), but the container's local disk isn't
 * guaranteed to survive a restart/redeploy, so we snapshot the whole
 * folder into `whatsapp_qr_sessions.auth_state` (AES-256-GCM-encrypted,
 * same helper as `whatsapp_config.access_token`) after every `creds.update`,
 * and restore it into a fresh folder before the socket starts. This
 * avoids re-implementing Baileys' full SignalKeyStore contract while
 * still surviving a redeploy without forcing the user to re-scan.
 */

export function authFolderPath(configId: string): string {
  return path.join(os.tmpdir(), 'wacrm-baileys', configId)
}

/** Populate the local auth folder from the encrypted DB snapshot, if any. */
export async function restoreAuthFolder(configId: string): Promise<void> {
  const folder = authFolderPath(configId)
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_qr_sessions')
    .select('auth_state')
    .eq('whatsapp_config_id', configId)
    .maybeSingle()

  if (error) {
    console.error('[whatsapp-qr] failed to load stored auth state:', error.message)
    return
  }
  if (!data?.auth_state) return

  let files: Record<string, string>
  try {
    files = JSON.parse(decrypt(data.auth_state))
  } catch (err) {
    console.error(
      '[whatsapp-qr] stored auth state is corrupt/undecryptable — starting a fresh pairing:',
      err instanceof Error ? err.message : err,
    )
    return
  }

  await fs.mkdir(folder, { recursive: true })
  for (const [name, base64] of Object.entries(files)) {
    await fs.writeFile(path.join(folder, name), Buffer.from(base64, 'base64'))
  }
}

// Debounced per-config — `creds.update` can fire many times in a burst
// during initial pairing/history sync; no need to hit the DB on every one.
const pendingSnapshots = new Map<string, NodeJS.Timeout>()
const SNAPSHOT_DEBOUNCE_MS = 2000

export function scheduleAuthSnapshot(configId: string): void {
  const existing = pendingSnapshots.get(configId)
  if (existing) clearTimeout(existing)
  pendingSnapshots.set(
    configId,
    setTimeout(() => {
      pendingSnapshots.delete(configId)
      void snapshotAuthFolderNow(configId)
    }, SNAPSHOT_DEBOUNCE_MS),
  )
}

async function snapshotAuthFolderNow(configId: string): Promise<void> {
  const folder = authFolderPath(configId)
  try {
    const names = await fs.readdir(folder)
    const files: Record<string, string> = {}
    for (const name of names) {
      const buf = await fs.readFile(path.join(folder, name))
      files[name] = buf.toString('base64')
    }
    const blob = encrypt(JSON.stringify(files))
    const { error } = await supabaseAdmin()
      .from('whatsapp_qr_sessions')
      .update({ auth_state: blob, updated_at: new Date().toISOString() })
      .eq('whatsapp_config_id', configId)
    if (error) {
      console.error('[whatsapp-qr] auth-state snapshot write failed:', error.message)
    }
  } catch (err) {
    console.error(
      '[whatsapp-qr] auth-state snapshot failed:',
      err instanceof Error ? err.message : err,
    )
  }
}

/** Wipe the local folder and clear the stored snapshot — used on logout. */
export async function clearAuthFolder(configId: string): Promise<void> {
  const folder = authFolderPath(configId)
  await fs.rm(folder, { recursive: true, force: true })
  const { error } = await supabaseAdmin()
    .from('whatsapp_qr_sessions')
    .update({ auth_state: null, updated_at: new Date().toISOString() })
    .eq('whatsapp_config_id', configId)
  if (error) {
    console.error('[whatsapp-qr] failed to clear stored auth state:', error.message)
  }
}
