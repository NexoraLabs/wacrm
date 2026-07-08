// ============================================================
// POST /api/billing/subscribe
//
// Admin-only. Body carries only Wompi *tokens* — the card token from
// `POST /v1/tokens/cards` (public key, called by the browser directly
// against Wompi, never through us) plus the acceptance tokens from
// `GET /v1/merchants/{public_key}`. Raw card data never reaches this
// server.
//
// Creates a Wompi payment source, then immediately charges it once
// (the first billing period). The transaction is typically PENDING at
// this point — `POST /api/wompi/webhook` is what actually flips the
// subscription to 'active' once Wompi confirms APPROVED. We also set
// status from the synchronous response here as a best-effort — some
// payment methods (e.g. certain cards) resolve APPROVED immediately.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/billing/admin-client'
import { PLAN } from '@/lib/billing/plan'
import { createPaymentSource, createTransaction } from '@/lib/billing/wompi-client'

interface SubscribeBody {
  card_token?: string
  acceptance_token?: string
  accept_personal_auth?: string
  customer_email?: string
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const body = (await request.json().catch(() => null)) as SubscribeBody | null
    if (
      !body?.card_token ||
      !body.acceptance_token ||
      !body.accept_personal_auth ||
      !body.customer_email
    ) {
      return NextResponse.json(
        {
          error:
            'card_token, acceptance_token, accept_personal_auth, and customer_email are all required',
        },
        { status: 400 },
      )
    }

    const paymentSource = await createPaymentSource({
      cardToken: body.card_token,
      customerEmail: body.customer_email,
      acceptanceToken: body.acceptance_token,
      acceptPersonalAuth: body.accept_personal_auth,
    })

    const reference = `sub_${ctx.accountId}_${Date.now()}`
    const transaction = await createTransaction({
      paymentSourceId: paymentSource.id,
      customerEmail: body.customer_email,
      reference,
      amountInCents: PLAN.amountInCents,
      currency: PLAN.currency,
    })

    const admin = supabaseAdmin()
    const periodEnd = new Date(
      Date.now() + PLAN.periodDays * 24 * 60 * 60 * 1000,
    ).toISOString()

    const { error } = await admin.from('account_subscriptions').upsert(
      {
        account_id: ctx.accountId,
        created_by: ctx.userId,
        status: transaction.status === 'APPROVED' ? 'active' : 'incomplete',
        wompi_payment_source_id: String(paymentSource.id),
        wompi_customer_email: body.customer_email,
        current_period_end: transaction.status === 'APPROVED' ? periodEnd : null,
        last_transaction_id: transaction.id,
        last_transaction_status: transaction.status,
      },
      { onConflict: 'account_id' },
    )

    if (error) {
      console.error('[POST /api/billing/subscribe] upsert error:', error)
      return NextResponse.json(
        { error: 'Charged Wompi but failed to save subscription state — contact support' },
        { status: 500 },
      )
    }

    return NextResponse.json({
      status: transaction.status,
      transaction_id: transaction.id,
    })
  } catch (err) {
    if (err instanceof Error && !('status' in err)) {
      // Wompi-client errors (network/API failures) aren't one of the
      // typed auth errors toErrorResponse knows about — surface the
      // message directly rather than collapsing to a generic 500,
      // since it's usually an actionable Wompi validation message.
      console.error('[POST /api/billing/subscribe] Wompi error:', err.message)
      return NextResponse.json({ error: err.message }, { status: 502 })
    }
    return toErrorResponse(err)
  }
}
