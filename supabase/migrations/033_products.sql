-- ============================================================
-- Product catalog (dropshipping-oriented)
--
-- Adds an account-scoped product catalog with a per-product AI
-- prompt, so the AI reply assistant (029_ai_reply.sql) can layer
-- product-specific instructions on top of the single account-wide
-- ai_configs.system_prompt instead of only ever using one global
-- prompt for every conversation.
--
-- Design notes:
--   * account-scoped + RLS, mirrors ai_configs / ai_knowledge_documents
--     (any member reads, agent+ writes, admin+ deletes — same tier as
--     ai_knowledge_documents).
--   * No `stock` column: in dropshipping the supplier owns inventory,
--     not the seller. `is_available` is a manual/import-driven toggle
--     rather than a quantity to track.
--   * `sku` is optional but unique per account when present.
--   * `ai_prompt` is an override layered on top of
--     ai_configs.system_prompt, not a replacement for it.
--   * ai_knowledge_documents.product_id lets the RAG helper scope
--     retrieval to "just this product" when one is in context, instead
--     of always searching the whole account knowledge base.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS products (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name           text NOT NULL,
  sku            text,
  description    text,
  price          numeric(12,2) NOT NULL DEFAULT 0,
  currency       text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  supplier_name  text,
  supplier_url   text,
  image_urls     text[] NOT NULL DEFAULT '{}',
  is_available   boolean NOT NULL DEFAULT true,
  ai_prompt      text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS products_account_id_idx ON products (account_id);

-- SKU unique per account when present (partial index — many rows will
-- have no SKU, especially hand-entered catalogs).
CREATE UNIQUE INDEX IF NOT EXISTS products_account_sku_key
  ON products (account_id, sku)
  WHERE sku IS NOT NULL;

ALTER TABLE products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS products_select ON products;
CREATE POLICY products_select ON products FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS products_insert ON products;
CREATE POLICY products_insert ON products FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS products_update ON products;
CREATE POLICY products_update ON products FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS products_delete ON products;
CREATE POLICY products_delete ON products FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_products_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS products_updated_at ON products;
CREATE TRIGGER products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW
  EXECUTE FUNCTION public.update_products_updated_at();

-- ============================================================
-- Link knowledge-base documents to a product (optional) so RAG
-- retrieval can be scoped to "just this product".
-- ============================================================
ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS ai_knowledge_documents_product_id_idx
  ON ai_knowledge_documents (product_id) WHERE product_id IS NOT NULL;

-- ============================================================
-- Deals <-> product (which product this sales opportunity is for)
-- ============================================================
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_deals_product ON deals(product_id);
