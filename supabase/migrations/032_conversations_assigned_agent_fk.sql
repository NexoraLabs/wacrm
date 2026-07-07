-- ============================================================
-- conversations.assigned_agent_id: add missing foreign key
--
-- Problem this solves:
--   * assigned_agent_id was added in 001_initial_schema.sql as a bare
--     UUID column with no REFERENCES clause, unlike every other
--     "who owns this row" column added since (deals.assigned_to,
--     notifications.actor_user_id), which all have an FK with an
--     ON DELETE SET NULL policy.
--   * app code always writes a real auth.users.id into this column
--     (message-thread assignment UI, automations engine, flows
--     engine) and 027_notifications.sql compares it directly against
--     auth.uid() — it is not polymorphic the way messages.sender_id
--     or message_reactions.actor_id legitimately are. The missing FK
--     is an oversight, not a deliberate design choice.
--   * without it, removing an account member or deleting an
--     auth.users row leaves conversations pointing at a UUID that no
--     longer exists, and PostgREST can't embed profiles via
--     `profiles!conversations_assigned_agent_id_fkey(*)` the way the
--     app already does for deals.assigned_to.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- 1. Null out any stale references before constraining (there should
--    be none in practice, but a bad UUID would make the ADD
--    CONSTRAINT below fail).
UPDATE conversations
SET assigned_agent_id = NULL
WHERE assigned_agent_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM auth.users WHERE auth.users.id = conversations.assigned_agent_id
  );

-- 2. Add the FK. PostgreSQL has no "ADD CONSTRAINT IF NOT EXISTS", so
--    guard via pg_constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'conversations_assigned_agent_id_fkey'
      AND conrelid = 'conversations'::regclass
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_assigned_agent_id_fkey
      FOREIGN KEY (assigned_agent_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 3. Index for the FK lookup / assignment filters.
CREATE INDEX IF NOT EXISTS idx_conversations_assigned_agent_id
  ON conversations(assigned_agent_id);
