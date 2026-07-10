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
