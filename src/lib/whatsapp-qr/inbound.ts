import { downloadMediaMessage, type WAMessage, type WASocket } from 'baileys'
import pino from 'pino'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { buildMediaPath } from '@/lib/storage/upload-media'
import { processMessage, type WhatsAppMessage } from '@/app/api/whatsapp/webhook/route'
import { jidToPhone } from './jid'

const CHAT_MEDIA_BUCKET = 'chat-media'
const logger = pino({ level: 'silent' })

/**
 * Baileys has no Meta-style "mediaId you verify later" — you get the
 * bytes right away (or never; expired media keys throw). Download once
 * and park it in the same `chat-media` bucket the Cloud API media proxy
 * ultimately serves from, so QR-connected numbers get a permanent public
 * URL instead of something that needs re-fetching from WhatsApp's CDN.
 */
async function uploadInboundMedia(
  accountId: string,
  buffer: Buffer,
  mimeType: string,
  extensionHint: string,
): Promise<string | null> {
  const path = buildMediaPath(accountId, `inbound.${extensionHint}`)
  const { error } = await supabaseAdmin()
    .storage.from(CHAT_MEDIA_BUCKET)
    .upload(path, buffer, { contentType: mimeType, upsert: false })
  if (error) {
    console.error('[whatsapp-qr] inbound media upload failed:', error.message)
    return null
  }
  const {
    data: { publicUrl },
  } = supabaseAdmin().storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path)
  return publicUrl
}

function extensionFor(mimeType: string): string {
  const sub = mimeType.split('/')[1]?.split(';')[0]
  return sub || 'bin'
}

/**
 * Convert one Baileys WAMessage into the same `WhatsAppMessage` shape
 * the Meta webhook builds, downloading + re-hosting any media first,
 * then hand off to the shared `processMessage` pipeline — contacts,
 * conversations, flows, automations, and AI auto-reply all work
 * identically regardless of which connection method delivered the
 * message.
 */
export async function handleInboundBaileysMessage(
  sock: WASocket,
  accountId: string,
  configOwnerUserId: string,
  configId: string,
  waMsg: WAMessage,
): Promise<void> {
  if (waMsg.key.fromMe) return // our own sends echo back; already persisted by the send path
  if (!waMsg.message || !waMsg.key.remoteJid) return
  // Only 1:1 chats — group messages have a different tenancy story
  // (many contacts per thread) that this CRM doesn't model.
  if (waMsg.key.remoteJid.endsWith('@g.us')) return

  const fromPhone = jidToPhone(waMsg.key.remoteJid)
  const contactName = waMsg.pushName || fromPhone
  const timestampSeconds =
    typeof waMsg.messageTimestamp === 'number'
      ? waMsg.messageTimestamp
      : Math.floor(Date.now() / 1000)
  const content = waMsg.message

  const message: WhatsAppMessage = {
    id: waMsg.key.id || `qr-${Date.now()}`,
    from: fromPhone,
    timestamp: String(timestampSeconds),
    type: 'text',
  }

  let precomputedMediaUrl: string | undefined

  if (content.conversation) {
    message.type = 'text'
    message.text = { body: content.conversation }
  } else if (content.extendedTextMessage?.text) {
    message.type = 'text'
    message.text = { body: content.extendedTextMessage.text }
  } else if (content.imageMessage) {
    const buf = await downloadSafely(waMsg, sock)
    const mime = content.imageMessage.mimetype || 'image/jpeg'
    precomputedMediaUrl = buf
      ? (await uploadInboundMedia(accountId, buf, mime, extensionFor(mime))) ?? undefined
      : undefined
    message.type = 'image'
    message.image = { id: 'qr-media', mime_type: mime, caption: content.imageMessage.caption || undefined }
  } else if (content.videoMessage) {
    const buf = await downloadSafely(waMsg, sock)
    const mime = content.videoMessage.mimetype || 'video/mp4'
    precomputedMediaUrl = buf
      ? (await uploadInboundMedia(accountId, buf, mime, extensionFor(mime))) ?? undefined
      : undefined
    message.type = 'video'
    message.video = { id: 'qr-media', mime_type: mime, caption: content.videoMessage.caption || undefined }
  } else if (content.documentMessage || content.documentWithCaptionMessage?.message?.documentMessage) {
    const doc = content.documentMessage || content.documentWithCaptionMessage!.message!.documentMessage!
    const buf = await downloadSafely(waMsg, sock)
    const mime = doc.mimetype || 'application/octet-stream'
    precomputedMediaUrl = buf
      ? (await uploadInboundMedia(accountId, buf, mime, extensionFor(mime))) ?? undefined
      : undefined
    message.type = 'document'
    message.document = {
      id: 'qr-media',
      mime_type: mime,
      filename: doc.fileName || undefined,
      caption: doc.caption || undefined,
    }
  } else if (content.audioMessage) {
    const buf = await downloadSafely(waMsg, sock)
    const mime = content.audioMessage.mimetype || 'audio/ogg'
    precomputedMediaUrl = buf
      ? (await uploadInboundMedia(accountId, buf, mime, extensionFor(mime))) ?? undefined
      : undefined
    message.type = 'audio'
    message.audio = { id: 'qr-media', mime_type: mime }
  } else if (content.locationMessage) {
    message.type = 'location'
    message.location = {
      latitude: content.locationMessage.degreesLatitude || 0,
      longitude: content.locationMessage.degreesLongitude || 0,
      name: content.locationMessage.name || undefined,
      address: content.locationMessage.address || undefined,
    }
  } else {
    // Unsupported type (sticker, poll, reaction, etc.) — v1 scope is
    // text/media/location, matching the Flows send_message/send_media
    // steps a QR-connected number is meant to support. Falls through
    // to processMessage's own "unsupported message type" text fallback.
    message.type = 'unsupported'
  }

  const contact = { profile: { name: contactName }, wa_id: fromPhone }

  await processMessage(
    message,
    contact,
    accountId,
    configOwnerUserId,
    undefined,
    configId,
    precomputedMediaUrl,
  )
}

async function downloadSafely(waMsg: WAMessage, sock: WASocket): Promise<Buffer | null> {
  try {
    const buf = await downloadMediaMessage(
      waMsg,
      'buffer',
      {},
      { reuploadRequest: sock.updateMediaMessage, logger },
    )
    return buf as Buffer
  } catch (err) {
    console.error('[whatsapp-qr] media download failed:', err instanceof Error ? err.message : err)
    return null
  }
}
