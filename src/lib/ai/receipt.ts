const VISION_MODEL = 'gpt-4o-mini'
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions'

export interface ReceiptVerdict {
  is_valid: boolean
  amount_seen: string | null
  reason: string
}

/**
 * Ask a vision model whether an inbound WhatsApp image plausibly looks
 * like a real payment receipt/screenshot (Nequi, Bancolombia, Daviplata,
 * or a Bre-B transfer) for at least `expectedAmount` COP. Used by the
 * `collect_payment_proof` flow node (`src/lib/flows/engine.ts`) to decide
 * whether to send a digital product's access link automatically.
 *
 * Same conventions as `transcribeAudio` (`src/lib/ai/transcribe.ts`):
 * app-level `OPENAI_TRANSCRIBE_API_KEY` (a generic OpenAI key, reused
 * here — not transcription-specific), best-effort (never throws,
 * returns `null` on any failure so the caller can degrade to "treat as
 * invalid / retry" rather than crashing the flow run).
 *
 * This is a plausibility check, not fraud-proof verification — a
 * motivated customer could still fool it with a convincing fake. The
 * `collect_payment_proof` node caps invalid attempts and hands off to
 * a human rather than looping forever, so a human is always the
 * ultimate backstop.
 */
export async function analyzeReceiptImage(
  buffer: Buffer,
  mimeType: string,
  options: { expectedAmount?: number; extraContext?: string } = {},
): Promise<ReceiptVerdict | null> {
  const apiKey = process.env.OPENAI_TRANSCRIBE_API_KEY
  if (!apiKey) return null

  try {
    const base64 = buffer.toString('base64')
    const dataUrl = `data:${mimeType};base64,${base64}`

    const amountLine = options.expectedAmount
      ? `The expected payment amount is ${options.expectedAmount} COP (Colombian pesos) — the receipt should show an amount at or above this.`
      : ''
    const contextLine = options.extraContext ? options.extraContext : ''
    const todayLine = `Today's real date is ${new Date().toISOString().slice(0, 10)} — use this as the ground truth "today" when judging the receipt's date/time. Do NOT rely on your own training-data sense of the current date, since it is out of date. Only flag a receipt as invalid on date grounds if it is clearly implausible relative to this real date (e.g. years in the past/future) — do not reject it merely for being dated today or within the last few days.`

    const systemPrompt = [
      'You are a fraud-aware assistant checking whether a WhatsApp image is a real Colombian payment confirmation screenshot (Nequi, Bancolombia, Daviplata, or a Bre-B / llave transfer).',
      todayLine,
      amountLine,
      contextLine,
      'Look for: a transaction/confirmation screen from one of those apps, a visible amount, a date/time, and a reference or transaction id. Flag as invalid: unrelated photos, blank/blurry images, screenshots of a different app, obvious edits or inconsistent fonts/alignment, or an amount clearly below what was expected.',
      'Respond with ONLY a JSON object, no markdown, no extra text: {"is_valid": boolean, "amount_seen": string or null, "reason": string (max 200 chars, in Spanish)}.',
    ]
      .filter(Boolean)
      .join('\n')

    const res = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Evalúa esta imagen como posible comprobante de pago.',
              },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 300,
      }),
    })

    if (!res.ok) {
      console.error(
        '[receipt] OpenAI vision call failed:',
        res.status,
        await res.text().catch(() => '<no body>'),
      )
      return null
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const raw = data.choices?.[0]?.message?.content
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<ReceiptVerdict>
    if (typeof parsed.is_valid !== 'boolean') return null

    return {
      is_valid: parsed.is_valid,
      amount_seen: typeof parsed.amount_seen === 'string' ? parsed.amount_seen : null,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    }
  } catch (err) {
    console.error(
      '[receipt] analyzeReceiptImage threw:',
      err instanceof Error ? err.message : err,
    )
    return null
  }
}
