import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveProductPromptContext } from './product-context'

interface FakeProduct {
  name: string
  ai_prompt: string | null
  specifications: Record<string, string>
}

function makeDb(opts: {
  deal?: { product_id: string | null } | null
  productById?: FakeProduct | null
  fallback?: { data: FakeProduct[]; count: number }
}) {
  return {
    from(table: string) {
      if (table === 'deals') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          not: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: () =>
            Promise.resolve({ data: opts.deal ?? null, error: null }),
        }
        return chain
      }
      // products
      return {
        select: (_cols: string, sel?: { count?: string }) => {
          if (sel?.count) {
            // Fallback (no-deal) path: .eq(account_id).limit(2)
            return {
              eq: () => ({
                limit: () =>
                  Promise.resolve({
                    data: opts.fallback?.data ?? [],
                    count: opts.fallback?.count ?? 0,
                    error: null,
                  }),
              }),
            }
          }
          // Deal-linked path: .eq(account_id).eq(id).maybeSingle()
          return {
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({ data: opts.productById ?? null, error: null }),
              }),
            }),
          }
        },
      }
    },
  } as unknown as SupabaseClient
}

describe('resolveProductPromptContext', () => {
  it('uses the deal-linked product when a deal exists', async () => {
    const db = makeDb({
      deal: { product_id: 'p1' },
      productById: { name: 'Foo', ai_prompt: 'Sell Foo for $10', specifications: {} },
    })
    const result = await resolveProductPromptContext(db, 'acct-1', 'conv-1')
    expect(result).toContain('Product in context: Foo')
    expect(result).toContain('Sell Foo for $10')
  })

  it("falls back to the account's sole product when no deal exists yet", async () => {
    const db = makeDb({
      deal: null,
      fallback: {
        data: [{ name: 'Solo Product', ai_prompt: 'The only thing we sell', specifications: {} }],
        count: 1,
      },
    })
    const result = await resolveProductPromptContext(db, 'acct-1', 'conv-1')
    expect(result).toContain('Product in context: Solo Product')
    expect(result).toContain('The only thing we sell')
  })

  it('returns null when no deal exists and the account has no products', async () => {
    const db = makeDb({ deal: null, fallback: { data: [], count: 0 } })
    expect(await resolveProductPromptContext(db, 'acct-1', 'conv-1')).toBeNull()
  })

  it('returns null when no deal exists and the account has 2+ products (ambiguous)', async () => {
    const db = makeDb({
      deal: null,
      fallback: {
        data: [
          { name: 'A', ai_prompt: 'a', specifications: {} },
          { name: 'B', ai_prompt: 'b', specifications: {} },
        ],
        count: 2,
      },
    })
    expect(await resolveProductPromptContext(db, 'acct-1', 'conv-1')).toBeNull()
  })
})
