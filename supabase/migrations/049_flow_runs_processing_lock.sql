-- ============================================================
-- 049_flow_runs_processing_lock.sql
--
-- Adds `locked_at` to `flow_runs` so the flow engine can serialize
-- processing of a single active run: two customer replies arriving
-- within a couple seconds of each other (e.g. a double-tap on two
-- different interactive buttons) were previously both advancing the
-- same run concurrently, each sending its own messages before either
-- committed — duplicate sends, only caught (too late) by the
-- existing optimistic `current_node_key` check. `locked_at` lets
-- dispatchInboundToFlows claim the run before doing any node work and
-- release it after, so the second reply waits and then sees the
-- already-advanced state instead of racing.
--
-- Idempotent — safe to re-run.
-- ============================================================

alter table public.flow_runs
  add column if not exists locked_at timestamptz;
