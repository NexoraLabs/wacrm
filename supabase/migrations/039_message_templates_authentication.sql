-- ============================================================
-- Support building AUTHENTICATION-category templates in-app
--
-- Problem this solves:
--   AUTHENTICATION templates were previously local-catalog dead ends —
--   the submit/edit routes returned a hard 400 and pointed users at
--   Meta's own Template Manager + "Sync from Meta" to bring the result
--   in read-only. Meta's AUTHENTICATION templates don't take free-text
--   body/footer at all: the BODY is auto-generated from the language +
--   an `add_security_recommendation` flag, and the FOOTER (if any) is
--   Meta's own "this code expires in N minutes" text driven by
--   `code_expiration_minutes`. Both need somewhere to live locally so
--   the builder can round-trip them on edit.
--
-- This migration:
--   1. Adds `add_security_recommendation` (bool, default false) —
--      mirrors the flag Meta puts on the BODY component.
--   2. Adds `code_expiration_minutes` (1-90, nullable) — mirrors the
--      flag Meta puts on the FOOTER component when set.
--
-- The OTP button itself (otp_type: COPY_CODE | ONE_TAP | ZERO_TAP, plus
-- package_name/signature_hash for ONE_TAP/ZERO_TAP) needs no new
-- column — it's stored as the single element of the existing `buttons`
-- JSONB array, same as every other button type.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS add_security_recommendation BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS code_expiration_minutes INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'message_templates_code_expiration_minutes_check'
      AND conrelid = 'message_templates'::regclass
  ) THEN
    ALTER TABLE message_templates
      ADD CONSTRAINT message_templates_code_expiration_minutes_check
      CHECK (code_expiration_minutes IS NULL OR code_expiration_minutes BETWEEN 1 AND 90);
  END IF;
END $$;
