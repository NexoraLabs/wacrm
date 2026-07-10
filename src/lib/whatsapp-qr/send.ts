import type { MediaKind } from '@/lib/whatsapp/meta-api'
import { getSession } from './session-manager'
import { enqueueSend } from './send-queue'
import { phoneToJid } from './jid'

export class QrSendError extends Error {}

export interface QrSendResult {
  messageId: string
}

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  zip: 'application/zip',
}

/** Baileys requires an explicit document mimetype (unlike Meta, which infers it) — best-effort from the file extension. */
function guessMimeType(nameOrUrl: string): string {
  const ext = nameOrUrl.split('.').pop()?.toLowerCase().split(/[?#]/)[0]
  return (ext && MIME_BY_EXTENSION[ext]) || 'application/octet-stream'
}

function requireSocket(configId: string) {
  const sock = getSession(configId)
  if (!sock) {
    throw new QrSendError(
      'This WhatsApp number is not currently connected (QR session offline). Reconnect it in Settings.',
    )
  }
  return sock
}

/** Mirrors sendTextMessage's calling shape from meta-api.ts, keyed by configId instead of Meta credentials. */
export async function sendTextMessage(args: {
  configId: string
  to: string
  text: string
}): Promise<QrSendResult> {
  const sock = requireSocket(args.configId)
  const jid = phoneToJid(args.to)
  console.log(`[whatsapp-qr:debug] sending text to ${jid} via ${args.configId}`)
  const result = await enqueueSend(args.configId, () =>
    sock.sendMessage(jid, { text: args.text }),
  )
  console.log('[whatsapp-qr:debug] send result:', JSON.stringify(result?.key))
  if (!result?.key.id) throw new QrSendError('WhatsApp did not return a message id')
  return { messageId: result.key.id }
}

/** Mirrors sendMediaMessage's calling shape from meta-api.ts. `link` is fetched by Baileys at send time, same as Meta's `link` field. */
export async function sendMediaMessage(args: {
  configId: string
  to: string
  kind: MediaKind
  link: string
  caption?: string
  filename?: string
}): Promise<QrSendResult> {
  const sock = requireSocket(args.configId)
  const jid = phoneToJid(args.to)

  const content =
    args.kind === 'image'
      ? { image: { url: args.link }, caption: args.caption }
      : args.kind === 'video'
        ? { video: { url: args.link }, caption: args.caption }
        : args.kind === 'audio'
          ? { audio: { url: args.link }, mimetype: 'audio/ogg; codecs=opus' }
          : {
              document: { url: args.link },
              mimetype: guessMimeType(args.filename || args.link),
              caption: args.caption,
              fileName: args.filename || 'file',
            }

  const result = await enqueueSend(args.configId, () => sock.sendMessage(jid, content))
  if (!result?.key.id) throw new QrSendError('WhatsApp did not return a message id')
  return { messageId: result.key.id }
}
