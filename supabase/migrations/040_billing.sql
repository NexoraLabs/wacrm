-- ============================================================
-- 040_billing.sql — SaaS membership billing (Wompi)
--
-- Adds `account_subscriptions` — one row per account, tracking whether
-- that account is paid up on the flat monthly wacrm subscription fee,
-- collected through Wompi (Colombian payment gateway).
--
-- Design notes
--   - Account-scoped and UNIQUE(account_id), exactly like `ai_configs`
--     / `whatsapp_config` — one subscription per workspace, teammates
--     share it.
--   - `status`:
--       'incomplete' — subscribed but the first charge hasn't been
--                      confirmed by the Wompi webhook yet.
--       'active'     — paid up; `current_period_end` is in the future.
--       'past_due'   — a renewal charge failed; the gate (when enabled)
--                      allows a grace window past `current_period_end`
--                      before cutting access.
--       'canceled'   — no longer billed; treated the same as past the
--                      grace window by the gate.
--   - `wompi_payment_source_id` is Wompi's *tokenized* reference to the
--     customer's card — never the card itself. Nullable until the
--     first successful tokenization.
--   - `last_transaction_id` / `last_transaction_status` are for
--     support/debugging (so "why was I charged/declined" doesn't
--     require digging through the Wompi dashboard) — not used by any
--     business logic.
--   - `created_by` records who set up billing (audit); ON DELETE SET
--     NULL so removing that teammate doesn't drop the account's
--     subscription.
--
-- Backfill: every account that exists BEFORE this migration is
-- grandfathered in as 'active' with `current_period_end` far in the
-- future. This billing feature ships with enforcement OFF by default
-- (see `BILLING_ENFORCEMENT_ENABLED` in application code) — the
-- grandfather backfill just means that whenever enforcement is later
-- turned on, existing accounts aren't retroactively locked out; only
-- accounts created after billing is live will need to actually
-- subscribe.
--
-- RLS
--   Settings-class, mirroring `ai_configs`: any member (viewer+) may
--   read the subscription status; only admin+ may create/update it.
--   The webhook + cron run under the service-role client and bypass
--   RLS entirely (they have no `auth.uid()`).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'account_subscription_status') THEN
    CREATE TYPE account_subscription_status AS ENUM (
      'incomplete', 'active', 'past_due', 'canceled'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS account_subscriptions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  created_by                uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status                    account_subscription_status NOT NULL DEFAULT 'incomplete',
  wompi_payment_source_id   text,
  wompi_customer_email      text,
  current_period_end        timestamptz,
  last_transaction_id       text,
  last_transaction_status   text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE account_subscriptions ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the account (viewer+) can see billing status
-- so the UI can show "your account isn't paid up" to anyone, not just
-- the admin who manages it.
DROP POLICY IF EXISTS account_subscriptions_select ON account_subscriptions;
CREATE POLICY account_subscriptions_select ON account_subscriptions FOR SELECT
  USING (is_account_member(account_id));

-- INSERT / UPDATE: admin+ only via the dashboard client. In practice
-- the subscribe/webhook/cron routes all write through the service-role
-- client (bypasses RLS) — these policies guard against a non-admin
-- somehow calling the table directly from the browser.
DROP POLICY IF EXISTS account_subscriptions_insert ON account_subscriptions;
CREATE POLICY account_subscriptions_insert ON account_subscriptions FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS account_subscriptions_update ON account_subscriptions;
CREATE POLICY account_subscriptions_update ON account_subscriptions FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

-- No DELETE policy — subscriptions are canceled (status change), never
-- removed, so the billing history/audit trail stays intact.

-- Keep updated_at fresh on every write (reuses the shared trigger fn
-- from migration 001, same as every other table with this column).
DROP TRIGGER IF EXISTS set_updated_at ON account_subscriptions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON account_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Backfill — grandfather every pre-existing account as 'active'.
-- ============================================================
INSERT INTO account_subscriptions (account_id, status, current_period_end)
SELECT a.id, 'active', '2099-01-01T00:00:00Z'::timestamptz
FROM accounts a
WHERE NOT EXISTS (
  SELECT 1 FROM account_subscriptions s WHERE s.account_id = a.id
);
