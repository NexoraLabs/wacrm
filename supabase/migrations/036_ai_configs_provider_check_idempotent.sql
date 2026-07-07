-- ============================================================
-- ai_configs_provider_check: make re-drop safe
--
-- 031_ai_openrouter_provider.sql does an unguarded
-- `drop constraint ai_configs_provider_check`, unlike every other
-- constraint-replacing migration in this repo (009, 013, 014, 021),
-- which all guard the drop. Fixed here rather than by editing 031
-- directly — 031 may already be applied in some environments, and
-- Supabase's migration history tracks files by checksum, so editing
-- an already-applied migration causes a history mismatch. Adding a
-- new migration keeps every environment's applied history intact.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

alter table ai_configs
  drop constraint if exists ai_configs_provider_check;

alter table ai_configs
  add constraint ai_configs_provider_check
  check (provider in ('openai', 'anthropic', 'openrouter'));
