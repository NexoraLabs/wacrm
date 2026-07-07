import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { parseSpecifications } from '@/lib/products'

type Params = { params: Promise<{ id: string }> }

const CURRENCY_RE = /^[A-Z]{3}$/

/**
 * GET /api/products/[id] — full product (any member).
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { id } = await params
    const { data, error } = await supabase
      .from('products')
      .select(
        'id, name, sku, description, price, currency, supplier_name, supplier_url, image_urls, is_available, ai_prompt, specifications, created_at, updated_at',
      )
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (error) {
      console.error('[products/[id] GET] error:', error)
      return NextResponse.json({ error: 'Failed to load product' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(data)
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * PATCH /api/products/[id]  (agent+)
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit(`products:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
    }

    const update: Record<string, unknown> = {}

    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
      update.name = name
    }
    if (body.sku !== undefined) {
      update.sku = typeof body.sku === 'string' ? body.sku.trim() || null : null
    }
    if (body.description !== undefined) {
      update.description =
        typeof body.description === 'string' ? body.description.trim() || null : null
    }
    if (body.price !== undefined) {
      if (typeof body.price !== 'number' || body.price < 0) {
        return NextResponse.json({ error: 'price must be a non-negative number' }, { status: 400 })
      }
      update.price = body.price
    }
    if (body.currency !== undefined) {
      if (typeof body.currency !== 'string' || !CURRENCY_RE.test(body.currency)) {
        return NextResponse.json({ error: 'currency must be a 3-letter code' }, { status: 400 })
      }
      update.currency = body.currency
    }
    if (body.supplier_name !== undefined) {
      update.supplier_name =
        typeof body.supplier_name === 'string' ? body.supplier_name.trim() || null : null
    }
    if (body.supplier_url !== undefined) {
      update.supplier_url =
        typeof body.supplier_url === 'string' ? body.supplier_url.trim() || null : null
    }
    if (body.image_urls !== undefined) {
      update.image_urls = Array.isArray(body.image_urls)
        ? body.image_urls.filter((u: unknown): u is string => typeof u === 'string')
        : []
    }
    if (body.is_available !== undefined) {
      update.is_available = Boolean(body.is_available)
    }
    if (body.ai_prompt !== undefined) {
      update.ai_prompt = typeof body.ai_prompt === 'string' ? body.ai_prompt.trim() || null : null
    }
    if (body.specifications !== undefined) {
      const parsed = parseSpecifications(body.specifications)
      if (!parsed) {
        return NextResponse.json(
          { error: 'specifications must be an object of string values' },
          { status: 400 },
        )
      }
      update.specifications = parsed
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('products')
      .update(update)
      .eq('account_id', accountId)
      .eq('id', id)
      .select('id')
      .maybeSingle()
    if (error) {
      console.error('[products/[id] PATCH] error:', error)
      if (error.code === '23505') {
        return NextResponse.json(
          { error: 'A product with this SKU already exists' },
          { status: 409 },
        )
      }
      return NextResponse.json({ error: 'Failed to update product' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/products/[id]  (admin+)
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const { error } = await supabase
      .from('products')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id)
    if (error) {
      console.error('[products/[id] DELETE] error:', error)
      return NextResponse.json({ error: 'Failed to delete product' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
