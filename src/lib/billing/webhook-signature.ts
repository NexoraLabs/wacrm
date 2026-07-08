import crypto from 'node:crypto'

/**
 * Verify the checksum Wompi attaches to `transaction.updated` webhook
 * POSTs.
 *
 * Wompi signs `concat(values of signature.properties, in order) +
 * timestamp + event_secret` with SHA256 and sends the result in both
 * the event body (`signature.checksum`) and the `X-Event-Checksum`
 * header. We recompute it server-side from the parsed body (Wompi's
 * scheme signs specific field values, not the raw bytes, unlike Meta's
 * HMAC-over-raw-body) and compare in constant time.
 *
 * Reference: https://docs.wompi.co/en/docs/colombia/eventos/
 *
 * Contract: `WOMPI_EVENTS_SECRET` is required. Fails closed — every
 * event is rejected until the operator configures it, matching
 * `verifyMetaWebhookSignature` in src/lib/whatsapp/webhook-signature.ts.
 */
export interface WompiEventBody {
  event: string
  data: { transaction: Record<string, unknown> }
  sent_at: string
  signature: { properties: string[]; checksum: string }
  timestamp: number
}

export function verifyWompiChecksum(body: WompiEventBody): boolean {
  const secret = process.env.WOMPI_EVENTS_SECRET
  if (!secret) {
    console.error(
      '[wompi-webhook] WOMPI_EVENTS_SECRET is not set — rejecting event. ' +
        'Configure it (Wompi Dashboard → Developers → Secrets) to enable ' +
        'webhook verification.',
    )
    return false
  }

  const properties = body?.signature?.properties
  const providedChecksum = body?.signature?.checksum
  if (!Array.isArray(properties) || typeof providedChecksum !== 'string') {
    return false
  }

  const concatenated = properties
    .map((path) => readPath(body.data, path))
    .join('')
  const toHash = `${concatenated}${body.timestamp}${secret}`
  const expected = crypto.createHash('sha256').update(toHash).digest('hex')

  const a = Buffer.from(expected.toLowerCase())
  const b = Buffer.from(providedChecksum.trim().toLowerCase())
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * Resolve a dotted path like "transaction.id" against the event's
 * `data` object — `signature.properties` names fields relative to
 * `data`, not the full body.
 */
function readPath(data: Record<string, unknown>, path: string): string {
  const parts = path.split('.')
  let cur: unknown = data
  for (const part of parts) {
    if (typeof cur !== 'object' || cur === null) return ''
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur === undefined || cur === null ? '' : String(cur)
}
