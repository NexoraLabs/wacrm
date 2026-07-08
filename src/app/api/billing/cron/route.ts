// ============================================================
// GET /api/billing/cron
//
// Sweep active subscriptions whose current_period_end has passed and
// charge their stored Wompi payment source again for the next period.
// Same auth pattern as src/app/api/flows/cron/route.ts — reuses
// `AUTOMATION_CRON_SECRET` so operators only provision one cron
// secret for the whole app, not a separate one per job.
//
// This call and /api/wompi/webhook race benignly: this route creates
// the charge and records whatever the *synchronous* Wompi response
// says; the webhook is the eventual source of truth once Wompi
// finishes processing (e.g. 3DS challenges resolve asynchronously).
// Both write the same columns so whichever lands last wins, and both
// are idempotent per transaction id.
//
// Hosting: run daily. `PLAN.periodDays` (30) gives ample slack even
// if this only fires once every 24h.
// ============================================================

import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/billing/admin-client'
import { PLAN } from '@/lib/billing/plan'
import { createTransaction } from '@/lib/billing/wompi-client'

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const { data: due, error } = await admin
    .from('account_subscriptions')
    .select('account_id, wompi_payment_source_id, wompi_customer_email')
    .eq('status', 'active')
    .not('wompi_payment_source_id', 'is', null)
    .lte('current_period_end', new Date().toISOString())

  if (error) {
    console.error('[billing-cron] scan failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!due?.length) return NextResponse.json({ charged: 0, failed: 0 })

  let charged = 0
  let failed = 0

  for (const row of due) {
    const reference = `sub_${row.account_id}_${Date.now()}`
    try {
      const transaction = await createTransaction({
        paymentSourceId: Number(row.wompi_payment_source_id),
        customerEmail: row.wompi_customer_email ?? '',
        reference,
        amountInCents: PLAN.amountInCents,
        currency: PLAN.currency,
      })

      const isApproved = transaction.status === 'APPROVED'
      const isFinalFailure = ['DECLINED', 'ERROR', 'VOIDED'].includes(
        transaction.status,
      )
      const periodEnd = new Date(
        Date.now() + PLAN.periodDays * 24 * 60 * 60 * 1000,
      ).toISOString()

      await admin
        .from('account_subscriptions')
        .update({
          last_transaction_id: transaction.id,
          last_transaction_status: transaction.status,
          ...(isApproved
            ? { status: 'active', current_period_end: periodEnd }
            : isFinalFailure
              ? { status: 'past_due' }
              : {}),
        })
        .eq('account_id', row.account_id)

      if (isApproved) charged += 1
      else if (isFinalFailure) failed += 1
    } catch (err) {
      console.error(
        `[billing-cron] charge failed for account ${row.account_id}:`,
        err,
      )
      await admin
        .from('account_subscriptions')
        .update({ status: 'past_due' })
        .eq('account_id', row.account_id)
      failed += 1
    }
  }

  return NextResponse.json({ charged, failed })
}
