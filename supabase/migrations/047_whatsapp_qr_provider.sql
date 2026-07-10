-- ============================================================
-- 047_whatsapp_qr_provider.sql — QR-linked WhatsApp as a second,
-- optional connection method alongside the official Cloud API.
--
-- Design notes
--   - `whatsapp_config.provider` discriminates the connection method:
--     'cloud_api' (existing behavior, unchanged) or 'qr' (new). Default
--     'cloud_api' so every existing row keeps working untouched.
--   - `phone_number_id` / `access_token` were NOT NULL because every
--     row used to be a Cloud API row. A 'qr' row has neither (Baileys
--     has no phone_number_id/access_token concept) — relaxed to
--     nullable, with a CHECK enforcing they're still required for
--     'cloud_api' rows so that path's invariants don't regress.
--   - `whatsapp_qr_sessions` holds everything QR-specific: the
--     encrypted Baileys auth-state blob (same encrypt()/decrypt() as
--     access_token — see src/lib/whatsapp/encryption.ts), the live
--     pairing QR (short-lived, rotates every ~20s while pending — not
--     a secret, so stored plaintext), connection status, and the
--     phone number Baileys reports once paired. 1:1 with
--     whatsapp_config via a UNIQUE FK.
--   - RLS mirrors whatsapp_config's settings-class pattern (any member
--     reads, admin+ writes) via a join back to whatsapp_config for the
--     account check, same shape as ai_configs (029).
--
-- Deliberately NOT changed: broadcasts, message templates, and Flow
-- interactive-button/list steps stay Cloud-API-only — there's no
-- unofficial equivalent of Meta's approved-template system. Those
-- features are gated in application code by checking
-- whatsapp_config.provider, not enforced here.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE whatsapp_config
  ALTER COLUMN phone_number_id DROP NOT NULL,
  ALTER COLUMN access_token DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'cloud_api'
    CHECK (provider IN ('cloud_api', 'qr'));

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_cloud_api_fields_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_cloud_api_fields_check CHECK (
    provider <> 'cloud_api'
    OR (phone_number_id IS NOT NULL AND access_token IS NOT NULL)
  );

CREATE TABLE IF NOT EXISTS whatsapp_qr_sessions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_config_id    uuid NOT NULL UNIQUE REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  auth_state            text,                     -- AES-256-GCM-encrypted JSON snapshot of the Baileys auth folder
  status                text NOT NULL DEFAULT 'qr_pending'
                          CHECK (status IN ('qr_pending', 'connecting', 'connected', 'disconnected', 'logged_out')),
  last_qr               text,                     -- current pairing QR string, cleared once connected
  linked_phone_number   text,                     -- populated from Baileys' creds.me.id once paired
  last_connected_at     timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE whatsapp_qr_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_qr_sessions_select ON whatsapp_qr_sessions;
CREATE POLICY whatsapp_qr_sessions_select ON whatsapp_qr_sessions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM whatsapp_config
      WHERE whatsapp_config.id = whatsapp_qr_sessions.whatsapp_config_id
        AND is_account_member(whatsapp_config.account_id)
    )
  );

DROP POLICY IF EXISTS whatsapp_qr_sessions_insert ON whatsapp_qr_sessions;
CREATE POLICY whatsapp_qr_sessions_insert ON whatsapp_qr_sessions FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM whatsapp_config
      WHERE whatsapp_config.id = whatsapp_qr_sessions.whatsapp_config_id
        AND is_account_member(whatsapp_config.account_id, 'admin')
    )
  );

DROP POLICY IF EXISTS whatsapp_qr_sessions_update ON whatsapp_qr_sessions;
CREATE POLICY whatsapp_qr_sessions_update ON whatsapp_qr_sessions FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM whatsapp_config
      WHERE whatsapp_config.id = whatsapp_qr_sessions.whatsapp_config_id
        AND is_account_member(whatsapp_config.account_id, 'admin')
    )
  );

DROP POLICY IF EXISTS whatsapp_qr_sessions_delete ON whatsapp_qr_sessions;
CREATE POLICY whatsapp_qr_sessions_delete ON whatsapp_qr_sessions FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM whatsapp_config
      WHERE whatsapp_config.id = whatsapp_qr_sessions.whatsapp_config_id
        AND is_account_member(whatsapp_config.account_id, 'admin')
    )
  );

CREATE INDEX IF NOT EXISTS idx_whatsapp_qr_sessions_config ON whatsapp_qr_sessions(whatsapp_config_id);
