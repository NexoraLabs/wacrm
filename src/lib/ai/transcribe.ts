const TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe'
const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions'

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes('ogg')) return 'ogg'
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a'
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3'
  if (mimeType.includes('wav')) return 'wav'
  if (mimeType.includes('amr')) return 'amr'
  return 'ogg'
}

/**
 * Transcribe an inbound WhatsApp voice note so flows/AI can read what the
 * customer actually said instead of treating it as opaque, textless media
 * (see `buildConversationContext`'s `content_type = 'text'` filter and
 * `parseMessageContent`'s 'audio' case). Uses an app-level OpenAI key —
 * deliberately NOT the account's own BYOK provider key, since accounts can
 * be on Anthropic (no STT) or OpenRouter (no dedicated transcription
 * endpoint, only a costlier multimodal-chat route) and this should behave
 * identically regardless of what chat provider an account has configured.
 *
 * Best-effort: returns `null` (never throws) when the key isn't
 * configured or the call fails, so a transcription outage degrades to
 * today's "no text" behavior rather than breaking message ingestion.
 */
export async function transcribeAudio(
  buffer: Buffer,
  mimeType: string,
): Promise<string | null> {
  const apiKey = process.env.OPENAI_TRANSCRIBE_API_KEY
  if (!apiKey) return null

  try {
    const form = new FormData()
    const filename = `audio.${extensionForMimeType(mimeType)}`
    // `Buffer`'s `.buffer` is typed `ArrayBufferLike` (could in principle
    // be a `SharedArrayBuffer`), which `BlobPart` rejects — copy into a
    // fresh, definitely-plain `ArrayBuffer` instead of casting around it.
    const arrayBuffer = new ArrayBuffer(buffer.byteLength)
    new Uint8Array(arrayBuffer).set(buffer)
    form.append('file', new Blob([arrayBuffer], { type: mimeType }), filename)
    form.append('model', TRANSCRIBE_MODEL)

    const res = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    })

    if (!res.ok) {
      console.error(
        '[transcribe] OpenAI transcription failed:',
        res.status,
        await res.text().catch(() => '<no body>'),
      )
      return null
    }

    const data = (await res.json()) as { text?: string }
    const text = typeof data.text === 'string' ? data.text.trim() : ''
    return text || null
  } catch (err) {
    console.error(
      '[transcribe] transcribeAudio threw:',
      err instanceof Error ? err.message : err,
    )
    return null
  }
}
