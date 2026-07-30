-- ============================================================
-- 051_flow_nodes_payment_proof_type.sql — allow 'collect_payment_proof'
-- as a flow_nodes.node_type
--
-- Adds a `collect_payment_proof` node type to the Flows builder: waits
-- for the customer's next inbound message to be an image, downloads
-- it, and calls a vision model (src/lib/ai/receipt.ts) to judge
-- whether it looks like a valid Nequi/Bancolombia/Daviplata/Bre-B
-- payment receipt before branching to on_valid_next_node_key /
-- on_invalid_next_node_key. Built for the lbolanosalban digital-
-- product (course) flow, but generic — any account can use it.
--
-- Same drop + recreate pattern as migrations 041/048 (Postgres has no
-- ADD VALUE for a plain CHECK).
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
    'ai_reply',
    'export_order',
    'collect_payment_proof'
  ));
