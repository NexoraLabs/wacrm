// ============================================================
// POST /api/wompi/webhook
//
// Public endpoint (Wompi can't send our session cookies) — auth is
// the checksum verification below, not a Supabase session. Mirrors
// src/app/api/whatsapp/webhook/route.ts's inbound-verification shape:
// read the raw body, verify, 401 on mismatch so the failure is visible
// in the Wompi dashboard rather than silently swallowed.
//
// `transaction.updated` is the only event we act on. The transaction's
// `reference` (set by us in /api/billing/subscribe and the cron) is
// `sub_<accountId>_<timestamp>` — parsed back out below to know which
// account's subscription row to update. No DB lookup needed to map a
// Wompi transaction id back to an account.
// ============================================================

import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/billing/admin-client'
import { PLAN } from '@/lib/billing/plan'
import { verifyWompiChecksum, type WompiEventBody } from '@/lib/billing/webhook-signature'

function accountIdFromReference(reference: string): string | null {
  const match = /^sub_([0-9a-f-]{36})_\d+$/i.exec(reference)
  return match ? match[1] : null
}

export async function POST(request: Request) {
  const rawBody = await request.text()

  let body: WompiEventBody
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!verifyWompiChecksum(body)) {
    console.warn('[wompi-webhook] rejected event with invalid checksum')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  if (body.event !== 'transaction.updated') {
    // Ack anything we don't act on so Wompi doesn't retry it forever.
    return NextResponse.json({ ok: true })
  }

  const transaction = body.data.transaction as {
    id: string
    status: string
    reference: string
  }
  const accountId = accountIdFromReference(transaction.reference)
  if (!accountId) {
    console.warn(
      '[wompi-webhook] could not parse account id from reference:',
      transaction.reference,
    )
    return NextResponse.json({ ok: true })
  }

  const admin = supabaseAdmin()
  const isApproved = transaction.status === 'APPROVED'
  const periodEnd = new Date(
    Date.now() + PLAN.periodDays * 24 * 60 * 60 * 1000,
  ).toISOString()

  const { data: existing } = await admin
    .from('account_subscriptions')
    .select('status')
    .eq('account_id', accountId)
    .maybeSingle()

  const { error } = await admin
    .from('account_subscriptions')
    .update({
      last_transaction_id: transaction.id,
      last_transaction_status: transaction.status,
      ...(isApproved
        ? { status: 'active', current_period_end: periodEnd }
        : existing?.status !== 'canceled'
          ? { status: 'past_due' }
          : {}),
    })
    .eq('account_id', accountId)

  if (error) {
    console.error('[wompi-webhook] failed to update subscription:', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
