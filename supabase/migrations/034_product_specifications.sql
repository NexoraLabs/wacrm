-- ============================================================
-- Product specifications (structured attributes)
--
-- products.ai_prompt (033_products.sql) is free-text instructions.
-- This adds a structured key/value bag — color, material, warranty,
-- shipping time, etc. — so the AI assistant can quote exact specs
-- instead of relying on the seller to spell them out in prose.
--
-- Kept as a flat JSONB object (string -> string), not a child table:
-- specs are display-only facts fed into a prompt, never queried or
-- filtered on individually, so a table + joins would be pure overhead.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS specifications JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Defensive: keep it a flat object (not an array/scalar/nested value)
-- since the app treats it as Record<string, string>.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'products_specifications_is_object'
      AND conrelid = 'products'::regclass
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_specifications_is_object
      CHECK (jsonb_typeof(specifications) = 'object');
  END IF;
END $$;
