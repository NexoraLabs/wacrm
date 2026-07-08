// ============================================================
// Subscription gate — NOT wired into any route yet.
//
// `requireActiveSubscription` only does anything when
// `BILLING_ENFORCEMENT_ENABLED=true`. Until Luis has a real Wompi
// account and has verified one subscription end-to-end in sandbox,
// this stays a no-op everywhere it's called (see the plan doc for
// why: shipping the engine now, flipping enforcement on later is a
// one-line env var change, not a code change).
// ============================================================

import { ForbiddenError } from '@/lib/auth/account'
import { supabaseAdmin } from './admin-client'

/** Renewal charges can fail transiently (expired card, bank hiccup) —
 *  this grace window keeps a paying customer's access alive while the
 *  cron retries before we call it truly lapsed. */
const GRACE_DAYS = 3

export function billingEnforcementEnabled(): boolean {
  return process.env.BILLING_ENFORCEMENT_ENABLED === 'true'
}

/**
 * Throws `ForbiddenError` if the account's subscription is lapsed AND
 * enforcement is turned on. No-op (returns immediately) otherwise.
 */
export async function requireActiveSubscription(
  accountId: string,
): Promise<void> {
  if (!billingEnforcementEnabled()) return

  const { data } = await supabaseAdmin()
    .from('account_subscriptions')
    .select('status, current_period_end')
    .eq('account_id', accountId)
    .maybeSingle()

  if (!data) {
    // No row at all shouldn't happen post-040 backfill, but fail
    // closed rather than silently letting an unbilled account through.
    throw new ForbiddenError('No active subscription for this account')
  }

  if (data.status === 'active') return

  if (data.status === 'past_due' && data.current_period_end) {
    const graceUntil =
      new Date(data.current_period_end).getTime() +
      GRACE_DAYS * 24 * 60 * 60 * 1000
    if (Date.now() <= graceUntil) return
  }

  throw new ForbiddenError('Subscription is not active')
}
