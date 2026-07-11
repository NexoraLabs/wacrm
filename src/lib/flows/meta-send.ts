// Cache-bust marker (2026-07-11): a prior "successful" deploy of the
// QR-menu-as-text fix below kept serving pre-fix behavior at runtime
// despite a real ~3min build being logged. Forcing a fresh commit here
// to rule out a stale-image/container-swap issue on the host side —
// see [[production_deploy_stuck]] memory if this recurs.
import {
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendTextMessage,
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
import {
  sendTextMessage as sendQrTextMessage,
  sendMediaMessage as sendQrMediaMessage,
} from '@/lib/whatsapp-qr/send'
import { decrypt } from '@/lib/whatsapp/encryption'
import { resolveWhatsappConfigForConversation } from '@/lib/whatsapp/resolve-config'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { supabaseAdmin } from './admin-client'

// ------------------------------------------------------------
// Flows-side Meta sender (interactive variants).
//
// Mirrors src/lib/automations/meta-send.ts (engineSendText /
// engineSendTemplate) but emits interactive button + list messages.
// Kept separate from the automations file so the two engines don't
// fight over each other's shape — once both stabilize, the
// phone-variant retry + DB persistence are obvious extraction
// candidates into a shared base.
//
// PR #1 ships this in isolation: callers don't exist yet. PR #2
// brings the flow runner online and wires it up. Shipping it now
// keeps the foundation PR self-contained and unit-testable.
// ------------------------------------------------------------

interface SendTextEngineArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so a flow authored by user A still sends through the
   *  WhatsApp number user B saved on the same account. */
  accountId: string
  /** Original author of the flow — used for INSERT audit columns
   *  and for resolving the agent's identity in logs. Not consulted
   *  for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
}

/**
 * Send a plain-text WhatsApp message from the Flows engine.
 *
 * Used by the runner's `send_message` and `collect_input` nodes —
 * both prompt the customer with text and either auto-advance (the
 * send_message case) or suspend awaiting a text reply (collect_input).
 *
 * Wraps the same phone-variant retry + DB persistence pattern as the
 * interactive senders; the duplication will be DRY'd into a shared
 * `engineSendBase` once the v2 features (templates with variables,
 * media sends) settle.
 */
export async function engineSendText(
  args: SendTextEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const config = await resolveWhatsappConfigForConversation(
    db,
    args.accountId,
    args.conversationId,
  )

  const accessToken = config.provider === 'cloud_api' ? decrypt(config.access_token) : ''

  const attempt = async (phone: string): Promise<string> => {
    if (config.provider === 'qr') {
      const r = await sendQrTextMessage({ configId: config.id, to: phone, text: args.text })
      return r.messageId
    }
    const r = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: args.text,
    })
    return r.messageId
  }

  const variants = phoneVariants(sanitized)
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: 'text',
    content_text: args.text,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: args.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)

  return { whatsapp_message_id: waMessageId }
}

interface SendMediaEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  kind: MediaKind
  /** Public URL Meta fetches at send time. */
  link: string
  caption?: string
  /** Document-only; ignored by Meta for image/video. */
  filename?: string
}

/**
 * Send an image / video / document from the Flows engine.
 *
 * Used by the runner's `send_media` node. Auto-advances after the
 * send lands (same suspend semantics as send_message). Same
 * phone-variant retry + DB persistence as the text/interactive
 * senders; persists the outgoing message with `content_type` matching
 * the media kind so the inbox renders the right preview.
 */
export async function engineSendMedia(
  args: SendMediaEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const config = await resolveWhatsappConfigForConversation(
    db,
    args.accountId,
    args.conversationId,
  )

  const accessToken = config.provider === 'cloud_api' ? decrypt(config.access_token) : ''

  const attempt = async (phone: string): Promise<string> => {
    if (config.provider === 'qr') {
      const r = await sendQrMediaMessage({
        configId: config.id,
        to: phone,
        kind: args.kind,
        link: args.link,
        caption: args.caption,
        filename: args.filename,
      })
      return r.messageId
    }
    const r = await sendMediaMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      kind: args.kind,
      link: args.link,
      caption: args.caption,
      filename: args.filename,
    })
    return r.messageId
  }

  const variants = phoneVariants(sanitized)
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  // content_type='image'|'video'|'document' — these are already in the
  // messages_content_type_check constraint (migration 001 + 010).
  // content_text carries the caption (or empty) so the conversation
  // list preview shows something meaningful when the user glances at it.
  const preview = args.caption?.trim() || `[${args.kind}]`
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: args.kind,
    content_text: args.caption ?? null,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: preview,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)

  return { whatsapp_message_id: waMessageId }
}

interface SendInteractiveButtonsEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttons: InteractiveButton[]
  headerText?: string
  footerText?: string
}

interface SendInteractiveListEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttonLabel: string
  sections: InteractiveListSection[]
  headerText?: string
  footerText?: string
}

/**
 * Send an interactive-button WhatsApp message from the Flows engine.
 *
 * Persists the outgoing message to `messages` with
 * `content_type='interactive'` and `sender_type='bot'` so the inbox
 * surfaces it with the "Button reply" affordance and the conversation
 * thread reflects the bot's prompt.
 *
 * Returns the Meta message id so the caller (engine) can stash it on
 * the `flow_runs.last_prompt_message_id` field for later reference.
 */
export async function engineSendInteractiveButtons(
  args: SendInteractiveButtonsEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'buttons' })
}

/**
 * Send an interactive-list WhatsApp message from the Flows engine.
 * Used when the flow needs more than 3 options (Meta's button cap).
 */
export async function engineSendInteractiveList(
  args: SendInteractiveListEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'list' })
}

type SendInput =
  | (SendInteractiveButtonsEngineArgs & { kind: 'buttons' })
  | (SendInteractiveListEngineArgs & { kind: 'list' })

async function sendInteractiveViaMeta(
  input: SendInput,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  // Scope the contact + whatsapp_config lookups by account_id —
  // same defense-in-depth rationale as automations/meta-send.ts.
  // Migration 017 moved both tables to account-scoped tenancy.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const config = await resolveWhatsappConfigForConversation(
    db,
    input.accountId,
    input.conversationId,
  )

  // Baileys/QR has no real interactive-button-tap protocol — render the
  // options as a numbered text menu instead and let the engine's
  // matchTextReplyToMenu() interpret the customer's plain-text reply
  // (a number or the option's own title) as if they'd tapped it. See
  // src/lib/flows/engine.ts.
  if (config.provider === 'qr') {
    return sendInteractiveAsQrText(db, config.id, sanitized, input)
  }

  const accessToken = decrypt(config.access_token)

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'buttons') {
      const r = await sendInteractiveButtons({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        bodyText: input.bodyText,
        buttons: input.buttons,
        headerText: input.headerText,
        footerText: input.footerText,
      })
      return r.messageId
    }
    const r = await sendInteractiveList({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      bodyText: input.bodyText,
      buttonLabel: input.buttonLabel,
      sections: input.sections,
      headerText: input.headerText,
      footerText: input.footerText,
    })
    return r.messageId
  }

  // Same phone-variant retry as automations/meta-send.ts. Numbers
  // registered with/without a trunk 0 + Meta's sandbox quirks all
  // need this to reliably land a message.
  const variants = phoneVariants(sanitized)
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  // Persist the bot's prompt to the messages table so it appears in
  // the inbox. content_type='interactive' is supported as of
  // migration 010; sender_type='bot' distinguishes flow sends from
  // manual agent sends (the conversation list preview will pick up
  // last_message_text as a sensible summary).
  //
  // We do NOT set interactive_reply_id here — that column is reserved
  // for the customer's tap on this message, populated by the webhook
  // when their reply arrives.
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type: 'interactive',
    content_text: input.bodyText,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: input.bodyText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.conversationId)

  return { whatsapp_message_id: waMessageId }
}

/** Numbers options sequentially: buttons top-to-bottom, list rows across all sections. */
function renderInteractiveAsText(input: SendInput): string {
  const lines: string[] = []
  if (input.headerText) lines.push(`*${input.headerText}*`, '')
  lines.push(input.bodyText, '')
  if (input.kind === 'buttons') {
    input.buttons.forEach((b, i) => lines.push(`${i + 1}. ${b.title}`))
  } else {
    let n = 1
    for (const section of input.sections) {
      if (section.title) lines.push(`_${section.title}_`)
      for (const row of section.rows) {
        lines.push(`${n}. ${row.title}${row.description ? ` — ${row.description}` : ''}`)
        n++
      }
    }
  }
  if (input.footerText) lines.push('', input.footerText)
  lines.push('', 'Responde con el número de la opción 👆')
  return lines.join('\n')
}

/**
 * QR-provider counterpart to the Cloud-API interactive send above —
 * same persistence shape (messages row + conversation preview update),
 * but as a plain numbered-text menu since Baileys has no interactive
 * message type to send.
 */
async function sendInteractiveAsQrText(
  db: ReturnType<typeof supabaseAdmin>,
  configId: string,
  toPhone: string,
  input: SendInput,
): Promise<{ whatsapp_message_id: string }> {
  const text = renderInteractiveAsText(input)
  const { messageId } = await sendQrTextMessage({ configId, to: toPhone, text })

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type: 'text',
    content_text: text,
    message_id: messageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(`sent via QR but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.conversationId)

  return { whatsapp_message_id: messageId }
}
