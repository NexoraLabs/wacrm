-- Allow 'openrouter' as a third AI provider alongside 'openai' and
-- 'anthropic' (bring-your-own-key). OpenRouter proxies many vendors
-- behind one OpenAI-compatible key, giving access to far more models.
alter table ai_configs
  drop constraint ai_configs_provider_check;

alter table ai_configs
  add constraint ai_configs_provider_check
  check (provider in ('openai', 'anthropic', 'openrouter'));
