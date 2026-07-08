import type { SupabaseClient } from '@supabase/supabase-js'

import { sendTypingIndicator as sendTypingIndicatorToMeta } from './meta-api'
import { decrypt } from './encryption'
import { resolveWhatsappConfigForConversation } from './resolve-config'

/**
 * Best-effort "typing…" bubble on the customer's WhatsApp while an AI
 * reply is being generated (which can take several seconds). Shared by
 * all three AI-generation call sites — the Flows `ai_reply` node, the
 * Automations `ai_reply` step, and standalone auto-reply — since none
 * of them persist anything for this call (unlike a real send, there's
 * no `messages` row to insert).
 *
 * Never throws: a failed typing indicator must not block or fail the
 * actual reply generation it's decorating. Errors are logged and
 * swallowed, mirroring how `set_tag` failures are handled in the flow
 * engine (non-fatal, best-effort side effect).
 */
export async function showTypingIndicator(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; metaMessageId: string },
): Promise<void> {
  try {
    const config = await resolveWhatsappConfigForConversation(
      db,
      args.accountId,
      args.conversationId,
    )
    await sendTypingIndicatorToMeta({
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
      metaMessageId: args.metaMessageId,
    })
  } catch (err) {
    console.error('[typing-indicator] failed to show typing bubble:', err)
  }
}
