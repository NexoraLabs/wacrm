// ============================================================
// Wompi API client — server-side only (uses the PRIVATE key).
//
// Card tokenization (POST /v1/tokens/cards, PUBLIC key) happens
// entirely in the browser — see billing-settings.tsx — so raw card
// data never reaches this server. This module only handles the two
// calls that require the private key:
//
//   1. createPaymentSource() — exchange a card token (+ acceptance
//      tokens) for a reusable `payment_source_id`.
//   2. createTransaction()   — charge a payment source, optionally
//      marked `recurrent: true` for subscription renewals.
//
// Reference: https://docs.wompi.co/en/docs/colombia/
// ============================================================

import { createHash } from 'node:crypto'

function baseUrl(): string {
  // Defaults to sandbox so a misconfigured deployment fails safely
  // (test transactions, not real charges) rather than the other way
  // around.
  return process.env.WOMPI_API_BASE_URL || 'https://sandbox.wompi.co/v1'
}

function privateKey(): string {
  const key = process.env.WOMPI_PRIVATE_KEY
  if (!key) throw new Error('WOMPI_PRIVATE_KEY is not configured')
  return key
}

function integritySecret(): string {
  const secret = process.env.WOMPI_INTEGRITY_SECRET
  if (!secret) throw new Error('WOMPI_INTEGRITY_SECRET is not configured')
  return secret
}

async function wompiFetch<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: init.method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${privateKey()}`,
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  })
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message =
      payload?.error?.messages
        ? JSON.stringify(payload.error.messages)
        : payload?.error?.reason || `Wompi request failed (${res.status})`
    throw new Error(message)
  }
  return payload as T
}

/**
 * SHA256(reference + amount_in_cents + currency + integrity_secret) —
 * Wompi's "firma de integridad", required on every transaction create
 * so the amount/currency can't be tampered with in flight.
 */
export function buildIntegritySignature(
  reference: string,
  amountInCents: number,
  currency: string,
): string {
  return createHash('sha256')
    .update(`${reference}${amountInCents}${currency}${integritySecret()}`)
    .digest('hex')
}

export interface WompiPaymentSource {
  id: number
  status: string
}

/**
 * Exchange a card token for a reusable payment source. `acceptanceToken`
 * and `acceptPersonalAuth` come from `GET /v1/merchants/{public_key}`,
 * fetched client-side alongside the card token (see billing-settings.tsx).
 */
export async function createPaymentSource(args: {
  cardToken: string
  customerEmail: string
  acceptanceToken: string
  acceptPersonalAuth: string
}): Promise<WompiPaymentSource> {
  const payload = await wompiFetch<{ data: WompiPaymentSource }>(
    '/payment_sources',
    {
      method: 'POST',
      body: {
        type: 'CARD',
        token: args.cardToken,
        customer_email: args.customerEmail,
        acceptance_token: args.acceptanceToken,
        accept_personal_auth: args.acceptPersonalAuth,
      },
    },
  )
  return payload.data
}

export interface WompiTransaction {
  id: string
  status: 'PENDING' | 'APPROVED' | 'DECLINED' | 'ERROR' | 'VOIDED'
  amount_in_cents: number
  reference: string
}

/**
 * Charge a stored payment source. Used for both the first subscribe
 * charge and every monthly renewal (`recurrent: true` in both cases —
 * Wompi's COF/"credential on file" flag for merchant-initiated,
 * customer-absent charges).
 */
export async function createTransaction(args: {
  paymentSourceId: number
  customerEmail: string
  reference: string
  amountInCents: number
  currency: string
}): Promise<WompiTransaction> {
  const signature = buildIntegritySignature(
    args.reference,
    args.amountInCents,
    args.currency,
  )
  const payload = await wompiFetch<{ data: WompiTransaction }>(
    '/transactions',
    {
      method: 'POST',
      body: {
        amount_in_cents: args.amountInCents,
        currency: args.currency,
        signature,
        customer_email: args.customerEmail,
        payment_source_id: args.paymentSourceId,
        reference: args.reference,
        recurrent: true,
      },
    },
  )
  return payload.data
}
