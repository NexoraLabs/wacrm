'use client';

// ============================================================
// BillingSettings — Settings → Billing
//
// Shows the account's Wompi subscription status. Any member can view
// it (read-only); admin+ can subscribe (gated by <RequireRole
// min="admin"> here and the admin-only /api/billing/subscribe route).
//
// Card tokenization happens directly against Wompi from the browser
// (public key only) — the raw card number never touches our server.
// We only ever send the resulting tokens to /api/billing/subscribe.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CreditCard, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RequireRole } from '@/components/auth/require-role';
import { SettingsPanelHead } from './settings-panel-head';

interface Subscription {
  status: 'incomplete' | 'active' | 'past_due' | 'canceled';
  current_period_end: string | null;
  wompi_customer_email: string | null;
  last_transaction_status: string | null;
}

const STATUS_LABEL: Record<Subscription['status'], string> = {
  active: 'Active',
  incomplete: 'Awaiting payment confirmation',
  past_due: 'Payment failed — update your card',
  canceled: 'Canceled',
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function BillingSettings() {
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/billing/status', { cache: 'no-store' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Failed to load billing status');
        return;
      }
      const data = (await res.json()) as { subscription: Subscription | null };
      setSubscription(data.subscription);
    } catch (err) {
      console.error('[BillingSettings] load error:', err);
      toast.error('Could not reach the server');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  const isActive = subscription?.status === 'active';

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title="Billing"
        description="Your wacrm subscription — billed monthly through Wompi."
      />

      <Card>
        <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <CreditCard className="text-muted-foreground size-5" />
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">
                  {subscription
                    ? STATUS_LABEL[subscription.status]
                    : 'Not subscribed'}
                </span>
                {subscription?.status === 'active' && (
                  <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                    Active
                  </Badge>
                )}
                {subscription?.status === 'past_due' && (
                  <Badge className="border-red-500/40 bg-red-500/10 text-red-300 text-[10px] tracking-wide uppercase">
                    Past due
                  </Badge>
                )}
              </div>
              {subscription?.current_period_end && (
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {isActive ? 'Renews' : 'Was due'}{' '}
                  {fmtDate(subscription.current_period_end)}
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {!isActive && (
        <RequireRole min="admin">
          <SubscribeForm onSubscribed={load} />
        </RequireRole>
      )}
    </section>
  );
}

// ------------------------------------------------------------
// Subscribe form — tokenizes the card directly against Wompi from
// the browser, then hands only the resulting tokens to our backend.
// ------------------------------------------------------------

interface WompiMerchantData {
  data: {
    presigned_acceptance: { acceptance_token: string };
    presigned_personal_data_auth: { acceptance_token: string };
  };
}

function wompiPublicBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_WOMPI_API_BASE_URL || 'https://sandbox.wompi.co/v1'
  );
}

function SubscribeForm({ onSubscribed }: { onSubscribed: () => void }) {
  const [email, setEmail] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [expMonth, setExpMonth] = useState('');
  const [expYear, setExpYear] = useState('');
  const [cvc, setCvc] = useState('');
  const [cardHolder, setCardHolder] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubscribe() {
    const publicKey = process.env.NEXT_PUBLIC_WOMPI_PUBLIC_KEY;
    if (!publicKey) {
      toast.error('Billing is not configured yet (missing Wompi public key)');
      return;
    }
    if (!email.trim() || !cardNumber || !expMonth || !expYear || !cvc || !cardHolder) {
      toast.error('Fill in every field');
      return;
    }

    setSubmitting(true);
    try {
      // 1. Acceptance tokens (T&Cs + personal-data-handling consent) —
      // required by Wompi before a payment source can be created.
      const merchantRes = await fetch(
        `${wompiPublicBaseUrl()}/merchants/${publicKey}`,
      );
      if (!merchantRes.ok) throw new Error('Could not reach Wompi');
      const merchant = (await merchantRes.json()) as WompiMerchantData;

      // 2. Tokenize the card — goes straight to Wompi, public key only.
      // The raw card number never touches our server.
      const tokenRes = await fetch(`${wompiPublicBaseUrl()}/tokens/cards`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${publicKey}`,
        },
        body: JSON.stringify({
          number: cardNumber.replace(/\s+/g, ''),
          exp_month: expMonth.padStart(2, '0'),
          exp_year: expYear,
          cvc,
          card_holder: cardHolder,
        }),
      });
      const tokenPayload = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || tokenPayload?.data?.status !== 'CREATED') {
        throw new Error(
          tokenPayload?.error?.reason || 'Card tokenization failed',
        );
      }

      // 3. Hand only the tokens to our backend — it creates the
      // payment source and charges the first period.
      const res = await fetch('/api/billing/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          card_token: tokenPayload.data.id,
          acceptance_token:
            merchant.data.presigned_acceptance.acceptance_token,
          accept_personal_auth:
            merchant.data.presigned_personal_data_auth.acceptance_token,
          customer_email: email.trim(),
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || 'Failed to subscribe');
        return;
      }
      toast.success(
        payload.status === 'APPROVED'
          ? 'Subscribed — payment approved'
          : 'Payment submitted — confirming with Wompi',
      );
      onSubscribed();
    } catch (err) {
      console.error('[BillingSettings] subscribe error:', err);
      toast.error(err instanceof Error ? err.message : 'Subscription failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <p className="text-sm font-medium text-foreground">Add a payment method</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-muted-foreground">Email</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-muted-foreground">Card number</Label>
            <Input
              value={cardNumber}
              onChange={(e) => setCardNumber(e.target.value)}
              placeholder="4242 4242 4242 4242"
              inputMode="numeric"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-muted-foreground">Cardholder name</Label>
            <Input value={cardHolder} onChange={(e) => setCardHolder(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-muted-foreground">CVC</Label>
            <Input value={cvc} onChange={(e) => setCvc(e.target.value)} inputMode="numeric" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-muted-foreground">Exp. month</Label>
            <Input value={expMonth} onChange={(e) => setExpMonth(e.target.value)} placeholder="MM" inputMode="numeric" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-muted-foreground">Exp. year</Label>
            <Input value={expYear} onChange={(e) => setExpYear(e.target.value)} placeholder="YY" inputMode="numeric" />
          </div>
        </div>
        <Button onClick={handleSubscribe} disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Processing…
            </>
          ) : (
            'Subscribe'
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
