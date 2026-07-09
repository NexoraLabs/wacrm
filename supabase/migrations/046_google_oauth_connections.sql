-- ============================================================
-- 046_google_oauth_connections.sql
--
-- Adds `account_google_connections`: one row per account holding an
-- encrypted Google OAuth refresh token. Replaces the earlier shared-
-- service-account design (migration 045) — instead of every product
-- owner sharing their spreadsheet with one fixed service-account
-- email, each account connects its OWN Google account once (Settings
-- → Google → "Connect with Google"), then any of that account's
-- products can pick a destination sheet via Google's file picker.
--
-- Settings-class table (mirrors whatsapp_config): any member may read
-- connection status (email + connected boolean only, surfaced via the
-- API — the encrypted token itself never leaves the server); admin+
-- may connect/disconnect.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.account_google_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  google_email TEXT,
  refresh_token_encrypted TEXT NOT NULL,
  scope TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id)
);

ALTER TABLE public.account_google_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_google_connections_select ON public.account_google_connections;
DROP POLICY IF EXISTS account_google_connections_insert ON public.account_google_connections;
DROP POLICY IF EXISTS account_google_connections_update ON public.account_google_connections;
DROP POLICY IF EXISTS account_google_connections_delete ON public.account_google_connections;

CREATE POLICY account_google_connections_select ON public.account_google_connections
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY account_google_connections_insert ON public.account_google_connections
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY account_google_connections_update ON public.account_google_connections
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY account_google_connections_delete ON public.account_google_connections
  FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON public.account_google_connections;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.account_google_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
