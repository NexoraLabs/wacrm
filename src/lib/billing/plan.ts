// ============================================================
// The single wacrm subscription plan.
//
// wacrm sells one flat monthly plan (no tiers) — this is the operator's
// own pricing, not a per-tenant setting, so it lives in code rather
// than an env var or a database row (matches how e.g.
// `INTERACTIVE_LIMITS` in src/lib/whatsapp/meta-api.ts lives in code).
// Edit `amountInCents` to change the price for every account.
// ============================================================

export const PLAN = {
  /** COP, in cents (Wompi's unit) — e.g. 4_990_000 = $49,900 COP. */
  amountInCents: 4_990_000,
  currency: 'COP',
  /** How long one paid period lasts before a renewal charge is due. */
  periodDays: 30,
} as const
