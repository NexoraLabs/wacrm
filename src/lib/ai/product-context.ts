import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Product context — layers a product's `ai_prompt` +
// `specifications` (033/034_products*.sql) on top of the account's
// business-wide `ai_configs.system_prompt` via buildSystemPrompt's
// `extraInstruction`.
//
// There's no direct conversation -> product link; the product is
// resolved through the conversation's most recent deal (deals.product_id),
// matching how the pipeline already associates a conversation with a
// sales opportunity. Best-effort: any failure just means "no product
// context", never an error surfaced to the caller.
// ============================================================

interface ProductRow {
  name: string
  ai_prompt: string | null
  specifications: Record<string, string>
}

function formatSpecifications(specs: Record<string, string>): string {
  return Object.entries(specs)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join('\n')
}

/**
 * Build the extra system-prompt instruction for the product tied to
 * this conversation, if any. Returns `null` when there's no linked
 * product or it has neither an `ai_prompt` nor `specifications`.
 */
export async function resolveProductPromptContext(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<string | null> {
  try {
    const { data: deal } = await db
      .from('deals')
      .select('product_id')
      .eq('conversation_id', conversationId)
      .not('product_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!deal?.product_id) return null

    // Point lookup by id rather than an embed off `deals` — avoids
    // relying on PostgREST's FK relationship cache for a table that
    // was just added (see getCurrentAccount's PGRST200 note).
    const { data: product } = await db
      .from('products')
      .select('name, ai_prompt, specifications')
      .eq('account_id', accountId)
      .eq('id', deal.product_id)
      .maybeSingle<ProductRow>()
    if (!product) return null

    const parts: string[] = []
    if (product.ai_prompt && product.ai_prompt.trim()) {
      parts.push(product.ai_prompt.trim())
    }
    if (product.specifications && Object.keys(product.specifications).length > 0) {
      parts.push(`Specifications:\n${formatSpecifications(product.specifications)}`)
    }
    if (parts.length === 0) return null

    return `Product in context: ${product.name}\n${parts.join('\n\n')}`
  } catch (err) {
    console.error('[resolveProductPromptContext] failed:', err)
    return null
  }
}
