-- ============================================================
-- Multi-number WhatsApp support (official Meta Cloud API only)
--
-- Problem this solves:
--   * whatsapp_config had UNIQUE(account_id) since 017_account_sharing.sql —
--     an account could connect exactly one WhatsApp number. Accounts that
--     run several business lines (e.g. "Sales", "Support") want up to 4
--     numbers, all through Meta's official API (no QR / unofficial
--     protocol — that carries a real ban risk and was explicitly ruled
--     out).
--
-- This migration:
--   1. Drops whatsapp_config_account_id_key so an account can hold more
--      than one row. whatsapp_config_phone_number_id_key (013) stays —
--      a given Meta phone number still can't be claimed twice.
--   2. Adds `label` (display name, e.g. "Ventas") and `is_default`
--      (which number outbound sends with no other signal should use —
--      fresh broadcasts, template sends with no prior conversation).
--   3. Backfills is_default = true on every existing row — today there's
--      at most one row per account, so this can never violate the
--      partial unique index added right after it.
--   4. Adds a partial unique index guaranteeing at most one default per
--      account.
--   5. Adds conversations.whatsapp_config_id so a conversation can be
--      anchored to the exact number it arrived on/was started from,
--      rather than every send resolving "the account's config" (which
--      stops being unambiguous once an account can have >1 number).
--
-- The 4-numbers-per-account cap is NOT enforced here — Postgres can't
-- count sibling rows in a CHECK constraint, and a trigger would be more
-- machinery than this needs. It's enforced in the API route that creates
-- rows (src/app/api/whatsapp/config/route.ts), consistent with how that
-- route already gates other conditions (duplicate phone_number_id, PIN
-- format) before writing.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS label TEXT,
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

-- Backfill before dropping the old constraint — while it's still in
-- place there's guaranteed to be at most one row per account, so this
-- can't collide with the partial unique index below.
UPDATE whatsapp_config SET is_default = true WHERE NOT is_default;

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_one_default_per_account
  ON whatsapp_config (account_id)
  WHERE is_default;

-- ============================================================
-- conversations.whatsapp_config_id — which number this thread is on.
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID
    REFERENCES whatsapp_config(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_config_id
  ON conversations(whatsapp_config_id);
