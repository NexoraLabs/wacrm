-- ============================================================
-- 042_automation_gaps.sql — widen notifications.type for the new
-- `notify_admin` automation step
--
-- Automations gained three new capabilities (see accompanying app
-- code): a `send_media` step, a `no_reply_since_last_message`
-- condition subject, and a `notify_admin` step. Only the last one
-- needs a DB change — it inserts into `notifications` (migration 027),
-- whose `type` CHECK constraint only allowed 'conversation_assigned'.
--
-- `send_media` and the new condition subject need no schema change:
-- `automation_steps.step_type` and `step_config` are unconstrained
-- TEXT/JSONB (migration 006), and the condition subject is just a
-- string compared in application code.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'automation_alert'));
