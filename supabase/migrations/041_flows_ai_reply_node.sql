-- ============================================================
-- 041_flows_ai_reply_node.sql — allow 'ai_reply' as a flow_nodes.node_type
--
-- Adds an `ai_reply` node type to the Flows builder: generates a
-- WhatsApp message with the account's AI assistant (same engine as
-- Automations' existing `ai_reply` step and the Inbox's "Draft with
-- AI") instead of sending fixed text, then auto-advances.
--
-- The CHECK constraint from migration 010 didn't include it — this
-- widens it the same way migration 016 widened messages.content_type
-- (drop + recreate, since Postgres has no ADD VALUE for a plain CHECK).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'handoff',
    'http_fetch',
    'end',
    'ai_reply'
  ));
