import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { parseSpecifications } from '@/lib/products'

const CURRENCY_RE = /^[A-Z]{3}$/

/**
 * GET /api/products
 *
 * List the account's product catalog (any member).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('products')
      .select(
        'id, name, sku, description, price, currency, supplier_name, supplier_url, image_urls, is_available, ai_prompt, specifications, created_at, updated_at',
      )
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
    if (error) {
      console.error('[products GET] error:', error)
      return NextResponse.json({ error: 'Failed to load products' }, { status: 500 })
    }
    return NextResponse.json({ products: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/products  (agent+)
 *
 * Create a product in the account's catalog.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit(`products:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }

    const sku = typeof body?.sku === 'string' ? body.sku.trim() || null : null
    const description =
      typeof body?.description === 'string' ? body.description.trim() || null : null
    const price = typeof body?.price === 'number' && body.price >= 0 ? body.price : 0
    const currency =
      typeof body?.currency === 'string' && CURRENCY_RE.test(body.currency)
        ? body.currency
        : 'USD'
    const supplierName =
      typeof body?.supplier_name === 'string' ? body.supplier_name.trim() || null : null
    const supplierUrl =
      typeof body?.supplier_url === 'string' ? body.supplier_url.trim() || null : null
    const imageUrls = Array.isArray(body?.image_urls)
      ? body.image_urls.filter((u: unknown): u is string => typeof u === 'string')
      : []
    const isAvailable = typeof body?.is_available === 'boolean' ? body.is_available : true
    const aiPrompt = typeof body?.ai_prompt === 'string' ? body.ai_prompt.trim() || null : null

    let specifications: Record<string, string> = {}
    if (body?.specifications !== undefined) {
      const parsed = parseSpecifications(body.specifications)
      if (!parsed) {
        return NextResponse.json(
          { error: 'specifications must be an object of string values' },
          { status: 400 },
        )
      }
      specifications = parsed
    }

    const { data, error } = await supabase
      .from('products')
      .insert({
        account_id: accountId,
        created_by: userId,
        name,
        sku,
        description,
        price,
        currency,
        supplier_name: supplierName,
        supplier_url: supplierUrl,
        image_urls: imageUrls,
        is_available: isAvailable,
        ai_prompt: aiPrompt,
        specifications,
      })
      .select('id')
      .single()
    if (error || !data) {
      console.error('[products POST] insert error:', error)
      if (error?.code === '23505') {
        return NextResponse.json(
          { error: 'A product with this SKU already exists' },
          { status: 409 },
        )
      }
      return NextResponse.json({ error: 'Failed to create product' }, { status: 500 })
    }

    return NextResponse.json({ success: true, id: data.id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
