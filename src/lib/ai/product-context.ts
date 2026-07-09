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
// sales opportunity. A deal is typically only created once the customer
// commits to buying (e.g. a keyword automation on "quiero pedirlo"), so
// every earlier message — including the very first pricing question —
// previously got no product context at all and the model had to guess
// (seen in production: asked for the price before any deal existed, the
// model invented one). Falls back to the account's sole product when
// there's no deal-linked one, covering the common single-product
// dropshipping setup this system was built for; with 0 or 2+ products
// and no deal it's genuinely ambiguous which one applies, so this still
// returns null. Best-effort: any failure just means "no product
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

    let product: ProductRow | null = null

    if (deal?.product_id) {
      // Point lookup by id rather than an embed off `deals` — avoids
      // relying on PostgREST's FK relationship cache for a table that
      // was just added (see getCurrentAccount's PGRST200 note).
      const { data } = await db
        .from('products')
        .select('name, ai_prompt, specifications')
        .eq('account_id', accountId)
        .eq('id', deal.product_id)
        .maybeSingle<ProductRow>()
      product = data
    } else {
      // No deal yet — fall back to the account's sole product, if it
      // has exactly one. With 0 or 2+ products this stays null; there's
      // no way to guess which one a pre-deal conversation is about.
      const { data, count } = await db
        .from('products')
        .select('name, ai_prompt, specifications', { count: 'exact' })
        .eq('account_id', accountId)
        .limit(2)
      if (count === 1 && data && data.length === 1) {
        product = data[0] as unknown as ProductRow
      }
    }

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
