-- ============================================================
-- 045_google_sheets_sync.sql
--
-- Adds `product_sheet_configs`: one row per PRODUCT holding which
-- Google Sheet its orders get appended to. A flow's `export_order`
-- node writes one row per completed order (shipping data + product +
-- quantity) whenever a customer finishes giving their delivery
-- details during a purchase conversation — this is an append-only
-- order log, not a contacts mirror.
--
-- Google credentials (service account) live server-side in env vars,
-- not in this table — a row only stores the target spreadsheet
-- id/tab. RLS mirrors `products` itself (any member reads, agent+
-- writes) since it's attached 1:1 to a product row.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.product_sheet_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  spreadsheet_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL DEFAULT 'Orders',
  last_exported_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(product_id)
);

CREATE INDEX IF NOT EXISTS idx_product_sheet_configs_account
  ON public.product_sheet_configs(account_id);

ALTER TABLE public.product_sheet_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_sheet_configs_select ON public.product_sheet_configs;
DROP POLICY IF EXISTS product_sheet_configs_insert ON public.product_sheet_configs;
DROP POLICY IF EXISTS product_sheet_configs_update ON public.product_sheet_configs;
DROP POLICY IF EXISTS product_sheet_configs_delete ON public.product_sheet_configs;

CREATE POLICY product_sheet_configs_select ON public.product_sheet_configs
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY product_sheet_configs_insert ON public.product_sheet_configs
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY product_sheet_configs_update ON public.product_sheet_configs
  FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY product_sheet_configs_delete ON public.product_sheet_configs
  FOR DELETE USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON public.product_sheet_configs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.product_sheet_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
