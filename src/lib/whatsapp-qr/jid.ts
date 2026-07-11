import { isLidUser } from 'baileys'
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'

/** Baileys/WhatsApp-Web JID suffix for a regular (non-group) chat. */
const USER_JID_SUFFIX = '@s.whatsapp.net'

/** Build a WhatsApp-Web JID from a phone number in any common format. */
export function phoneToJid(phone: string): string {
  return `${sanitizePhoneForMeta(phone)}${USER_JID_SUFFIX}`
}

/**
 * Extract a plain digits-only phone number from any JID shape Baileys
 * hands back (`<digits>@s.whatsapp.net`, or `<digits>:<device>@s.whatsapp.net`
 * for a specific linked device).
 */
export function jidToPhone(jid: string): string {
  const [user] = jid.split('@')
  const [digits] = user.split(':')
  return digits
}

/**
 * WhatsApp's privacy-preserving "LID" addressing delivers some inbound
 * messages with `key.remoteJid` as an opaque `<digits>@lid` identifier
 * instead of the sender's real phone-number JID — the digits look like a
 * phone number but aren't one. Sending a reply built from them (via
 * `phoneToJid`) silently fails to deliver (no error, no message ever
 * reaches the real recipient), while contacts/replies stored under that
 * LID look totally normal in the CRM. Baileys exposes the real
 * phone-number JID on `key.remoteJidAlt` for exactly this case — prefer
 * it whenever `remoteJid` is a LID.
 */
export function resolveInboundPhone(key: { remoteJid?: string | null; remoteJidAlt?: string | null }): string {
  if (key.remoteJid && isLidUser(key.remoteJid) && key.remoteJidAlt) {
    return jidToPhone(key.remoteJidAlt)
  }
  return jidToPhone(key.remoteJid || '')
}
