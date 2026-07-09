import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { resolveProductPromptContext } from './product-context'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { latestUserMessage } from './query'
import { engineSendText } from '@/lib/flows/meta-send'
import { showTypingIndicator } from '@/lib/whatsapp/typing-indicator'
import { triggerMatches } from '@/lib/automations/engine'
import type { Automation } from '@/types'

/**
 * A conversation just went dark on auto-reply (handoff, empty model
 * output, or the reply cap was hit) — the customer may be mid-purchase
 * with nobody now watching the thread. Alert the account owner via the
 * in-app notification bell rather than leaving it to be discovered by
 * chance. Best-effort: a failed notification must not surface as a
 * dispatch failure.
 */
async function notifyOwnerAutoReplyStopped(
  db: SupabaseClient,
  args: {
    accountId: string
    userId: string
    conversationId: string
    contactId: string
    reason: 'handoff' | 'reply_cap_reached'
  },
): Promise<void> {
  try {
    await db.from('notifications').insert({
      account_id: args.accountId,
      user_id: args.userId,
      type: 'automation_alert',
      conversation_id: args.conversationId,
      contact_id: args.contactId,
      actor_user_id: null,
      title:
        args.reason === 'handoff'
          ? '🤝 La IA necesita que tomes esta conversación'
          : '⏸️ La IA llegó al límite de respuestas en esta conversación',
      body:
        args.reason === 'handoff'
          ? 'El asistente no pudo resolver la conversación con confianza y se detuvo. Revísala en el Inbox.'
          : 'Se alcanzó el máximo de respuestas automáticas configurado para esta cuenta. El cliente puede seguir esperando — revisa el Inbox.',
    })
  } catch (err) {
    console.error('[ai auto-reply] failed to notify owner:', err)
  }
}

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** The inbound message id being replied to — shows a "typing…"
   *  bubble on the customer's WhatsApp while the LLM call is in flight. */
  metaMessageId: string
  /** The customer's raw message text — needed to check whether an active
   *  keyword_match automation actually matches THIS message (see the
   *  stand-down check below) rather than standing down just because one
   *  exists on the account. */
  messageText: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The last two of those are NOT fully silent: the first time either
 * fires for a conversation, it flips `ai_autoreply_disabled` (sticky —
 * stays off until an admin re-enables it) and notifies the account
 * owner via the in-app bell, so a customer mid-purchase who outpaces
 * the reply cap or stumps the model doesn't just sit unanswered with
 * no one aware. See `notifyOwnerAutoReplyStopped` above.
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId, metaMessageId, messageText } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so we stand down when one will actually fire for THIS
    // message, to avoid double-texting the customer. (Relationship
    // triggers like `first_inbound_message` don't count — they're not
    // per-message auto-responders.)
    //
    // Checking real relevance (not just "does one exist") matters: an
    // account can have an active keyword_match automation for one exact
    // phrase (e.g. an order-intent trigger) while still wanting the AI
    // to answer every OTHER message — standing down unconditionally
    // silenced the AI for the entire account the moment any such
    // automation existed, regardless of whether it applied.
    const { data: autoResponders } = await db
      .from('automations')
      .select('id, trigger_type, trigger_config')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
    if (
      autoResponders?.some((a) =>
        triggerMatches(a as unknown as Automation, { message_text: messageText }),
      )
    ) {
      return
    }

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound). Still sticky +
    // notifies like the atomic path below — otherwise a contact who
    // keeps messaging past the cap gets silently ignored forever with
    // nobody aware, since this branch would return before ever reaching
    // the notify call later in the function.
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) {
      await db
        .from('conversations')
        .update({ ai_autoreply_disabled: true })
        .eq('id', conversationId)
      await notifyOwnerAutoReplyStopped(db, {
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        reason: 'reply_cap_reached',
      })
      return
    }

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    const productContext = await resolveProductPromptContext(
      db,
      accountId,
      conversationId,
    )

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      extraInstruction: productContext ?? undefined,
    })

    await showTypingIndicator(db, { accountId, conversationId, metaMessageId })

    const { text, handoff } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and leave the inbound unanswered so it surfaces in
      // the inbox for a human. Sticky until an admin re-enables.
      await db
        .from('conversations')
        .update({ ai_autoreply_disabled: true })
        .eq('id', conversationId)
      await notifyOwnerAutoReplyStopped(db, {
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        reason: 'handoff',
      })
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) return
    if (claimed !== true) {
      // The cap is genuinely reached (not a transient DB error) — make
      // it sticky like the handoff path above, and tell the owner,
      // since a customer mid-purchase could otherwise sit unanswered
      // with no signal anyone should look.
      await db
        .from('conversations')
        .update({ ai_autoreply_disabled: true })
        .eq('id', conversationId)
      await notifyOwnerAutoReplyStopped(db, {
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        reason: 'reply_cap_reached',
      })
      return
    }

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
    })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
