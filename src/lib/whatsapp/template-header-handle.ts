import { uploadResumableMedia } from '@/lib/whatsapp/meta-api'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'

/**
 * Meta requires an `example.header_handle` (from the Resumable Upload
 * API) to create/edit a template with a media header — a plain public
 * URL is not accepted at creation time. This helper turns the template's
 * `header_media_url` (whether the user uploaded a file or pasted a link)
 * into a handle and writes it onto the payload, so both the upload path
 * and the legacy URL path actually succeed.
 *
 * No-op unless the header is IMAGE/VIDEO/DOCUMENT and has a URL but no
 * handle yet.
 */

// Meta's template-header sample limits per media type.
const HEADER_MEDIA_LIMITS: Record<
  'image' | 'video' | 'document',
  {
    maxBytes: number
    allowedTypes: string[]
    allowedLabel: string
    defaultType: string
    extension: string
  }
> = {
  image: {
    maxBytes: 5 * 1024 * 1024,
    allowedTypes: ['image/jpeg', 'image/png'],
    allowedLabel: 'JPEG or PNG',
    defaultType: 'image/jpeg',
    extension: 'jpg',
  },
  video: {
    maxBytes: 16 * 1024 * 1024,
    allowedTypes: ['video/mp4', 'video/3gpp'],
    allowedLabel: 'MP4 or 3GPP',
    defaultType: 'video/mp4',
    extension: 'mp4',
  },
  document: {
    maxBytes: 100 * 1024 * 1024,
    allowedTypes: ['application/pdf'],
    allowedLabel: 'PDF',
    defaultType: 'application/pdf',
    extension: 'pdf',
  },
}

export async function ensureHeaderHandle(
  payload: TemplatePayload,
  accessToken: string,
): Promise<void> {
  const headerType = payload.header_type
  if (headerType !== 'image' && headerType !== 'video' && headerType !== 'document') return
  if (payload.header_handle) return // already have one
  if (!payload.header_media_url) return // validator already requires url-or-handle

  const appId = process.env.META_APP_ID
  if (!appId) {
    throw new Error(
      'Media-header templates need META_APP_ID set (used for Meta’s Resumable Upload). Add it to your environment, or remove the header.',
    )
  }

  const limits = HEADER_MEDIA_LIMITS[headerType]

  // Fetch the sample bytes (works for our uploaded chat-media URL and
  // for a manually-pasted public link).
  let res: Response
  try {
    res = await fetch(payload.header_media_url)
  } catch {
    throw new Error(`Could not fetch the header ${headerType} URL. Make sure it is publicly reachable.`)
  }
  if (!res.ok) {
    throw new Error(`Header ${headerType} URL returned ${res.status}. It must be publicly reachable.`)
  }

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (contentType && !limits.allowedTypes.includes(contentType)) {
    throw new Error(
      `Header ${headerType} must be ${limits.allowedLabel} (got ${contentType}).`,
    )
  }

  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength === 0) {
    throw new Error(`Header ${headerType} is empty.`)
  }
  if (bytes.byteLength > limits.maxBytes) {
    throw new Error(
      `Header ${headerType} is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB — Meta's limit is ${limits.maxBytes / 1024 / 1024} MB.`,
    )
  }

  const mimeType = limits.allowedTypes.includes(contentType) ? contentType : limits.defaultType
  const fileName = `header.${limits.extension}`

  const { handle } = await uploadResumableMedia({
    appId,
    accessToken,
    fileName,
    mimeType,
    bytes,
  })
  payload.header_handle = handle
}
