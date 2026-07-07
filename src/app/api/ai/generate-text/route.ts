import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { buildTaskPrompt } from '@/lib/ai/defaults'
import { AiError } from '@/lib/ai/types'

const MAX_INSTRUCTION_LENGTH = 2000

/**
 * POST /api/ai/generate-text  (agent+)
 *
 * Body: { instruction }
 * Returns: { text } — one-off generated copy, no conversation involved.
 *
 * Used by the broadcast wizard's "Generate with AI" button (drafting a
 * static template-variable value). Uses the account's configured
 * provider/key (BYO), same as /api/ai/draft.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const userLimit = checkRateLimit(`ai-generate:${userId}`, RATE_LIMITS.aiDraft)
    if (!userLimit.success) return rateLimitResponse(userLimit)
    const accountLimit = checkRateLimit(
      `ai-generate-acct:${accountId}`,
      RATE_LIMITS.aiDraftAccount,
    )
    if (!accountLimit.success) return rateLimitResponse(accountLimit)

    const body = await request.json().catch(() => null)
    const instruction =
      body && typeof body.instruction === 'string' ? body.instruction.trim() : ''
    if (!instruction) {
      return NextResponse.json({ error: 'instruction is required' }, { status: 400 })
    }
    if (instruction.length > MAX_INSTRUCTION_LENGTH) {
      return NextResponse.json(
        { error: `instruction must be ${MAX_INSTRUCTION_LENGTH} characters or fewer` },
        { status: 400 },
      )
    }

    const config = await loadAiConfig(supabase, accountId).catch((err) => {
      console.error('[ai/generate-text] loadAiConfig error:', err)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error: 'AI assistant is not set up. Enable it in Settings → AI Assistant.',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    const systemPrompt = buildTaskPrompt({ businessContext: config.systemPrompt })
    const { text } = await generateReply({
      config,
      systemPrompt,
      messages: [{ role: 'user', content: instruction }],
    })
    return NextResponse.json({ text })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
