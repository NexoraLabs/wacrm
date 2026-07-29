import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { resolveAnyWhatsappConfigForAccount } from '@/lib/whatsapp/resolve-config'
import { sendTextMessage } from '@/lib/whatsapp/meta-api'

/**
 * Best-effort WhatsApp alert to the account owner's own phone, sent from
 * the account's connected number, when the AI gives up on a conversation
 * (handoff / reply cap / blocked fabrication) and nobody else may be
 * watching the in-app notification bell — the gap that let real
 * customers sit unanswered for hours (see notifyOwnerAutoReplyStopped /
 * notifyOwnerOfBlockedFabrication callers).
 *
 * WhatsApp only allows free-form text within 24h of the recipient last
 * messaging the sending number — since the owner's phone is not a
 * regular "customer" of their own bot, this can silently fail to
 * deliver if that window has lapsed. Accepted tradeoff (vs. a Meta
 * template, which needs a one-time approval wait) — see the account's
 * AI Assistant settings for the caveat shown to the user.
 *
 * Never throws — a failed alert must not break the caller's own
 * (already best-effort) notification flow.
 */
export async function notifyOwnerViaWhatsApp(
  db: SupabaseClient,
  args: { accountId: string; text: string },
): Promise<void> {
  const { accountId, text } = args
  try {
    const { data: aiConfig } = await db
      .from('ai_configs')
      .select('owner_notification_phone')
      .eq('account_id', accountId)
      .maybeSingle()
    const ownerPhone = aiConfig?.owner_notification_phone as string | null | undefined
    if (!ownerPhone) return

    const config = await resolveAnyWhatsappConfigForAccount(db, accountId)
    if (!config) return

    await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
      to: ownerPhone,
      text,
    })
  } catch (err) {
    console.error('[notify-owner-whatsapp] failed to send owner alert:', err)
  }
}
