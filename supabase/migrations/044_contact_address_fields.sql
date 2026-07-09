-- ============================================================
-- 044_contact_address_fields.sql
--
-- Adds delivery-address columns to `contacts`: address, city,
-- department (state/province — "departamento" in Colombia and
-- elsewhere in Latin America), and neighborhood ("barrio"). Lets the
-- CSV importer and contact form/detail view capture shipping info
-- alongside the existing name/phone/email/company fields, instead of
-- requiring a Custom Field per account.
--
-- Idempotent — safe to re-run.
-- ============================================================

alter table public.contacts
  add column if not exists address text,
  add column if not exists city text,
  add column if not exists department text,
  add column if not exists neighborhood text;
