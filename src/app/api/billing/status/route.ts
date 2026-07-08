// ============================================================
// GET /api/billing/status
//
// Any member (viewer+) can read their account's subscription state —
// matches the `ai_configs_select` read pattern (any member should be
// able to see "this workspace isn't paid up", not just admins).
// ============================================================

import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

export async function GET() {
  try {
    const ctx = await getCurrentAccount()

    const { data, error } = await ctx.supabase
      .from('account_subscriptions')
      .select(
        'status, current_period_end, wompi_customer_email, last_transaction_status',
      )
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (error) {
      console.error('[GET /api/billing/status] fetch error:', error)
      return NextResponse.json(
        { error: 'Failed to load subscription status' },
        { status: 500 },
      )
    }

    return NextResponse.json({ subscription: data ?? null })
  } catch (err) {
    return toErrorResponse(err)
  }
}
