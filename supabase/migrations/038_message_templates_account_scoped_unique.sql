-- ============================================================
-- Scope the message_templates uniqueness to the account, not the
-- creating user.
--
-- Problem this solves:
--   message_templates_user_name_language_key (014) is UNIQUE(user_id,
--   name, language) — a leftover from before multi-user accounts
--   (017). Two teammates on the same account can each submit a
--   template named "order_confirmation" and get two rows, because the
--   constraint never looked at account_id. The submit route's upsert
--   (src/app/api/whatsapp/templates/submit/route.ts) relies on this
--   index as its ON CONFLICT target, so the same bug meant a
--   teammate's resubmit of an existing template could silently create
--   a duplicate row instead of updating it.
--
-- This migration:
--   1. Fails loudly (same pattern as 014) if any account already has
--      two rows with the same (account_id, name, language) — an
--      operator has to pick which to keep before this can proceed.
--   2. Drops the old per-user unique index.
--   3. Adds UNIQUE(account_id, name, language).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DO $$
DECLARE
  dupe_count INT;
  sample TEXT;
BEGIN
  SELECT count(*) INTO dupe_count
  FROM (
    SELECT account_id, name, language
    FROM message_templates
    GROUP BY account_id, name, language
    HAVING count(*) > 1
  ) dupes;

  IF dupe_count > 0 THEN
    SELECT string_agg(
      account_id::text || ' / ' || name || ' / ' || COALESCE(language, '(null)') ||
        ' (' || count || ' rows)',
      E'\n  '
    )
    INTO sample
    FROM (
      SELECT account_id, name, language, count(*) AS count
      FROM message_templates
      GROUP BY account_id, name, language
      HAVING count(*) > 1
    ) dupe_detail;

    RAISE EXCEPTION
      E'Cannot add UNIQUE(account_id, name, language) on message_templates — % duplicate combination(s):\n  %\nDelete the rows you do not want to keep, then re-run migrations.',
      dupe_count, sample;
  END IF;
END $$;

DROP INDEX IF EXISTS message_templates_user_name_language_key;

CREATE UNIQUE INDEX IF NOT EXISTS message_templates_account_name_language_key
  ON message_templates (account_id, name, language);
