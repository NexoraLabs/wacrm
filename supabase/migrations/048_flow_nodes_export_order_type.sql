-- ============================================================
-- 048_flow_nodes_export_order_type.sql — allow 'export_order' as a
-- flow_nodes.node_type
--
-- Migration 045 (Google Sheets order export) added the
-- `product_sheet_configs` table and the application-level
-- `ExportOrderNodeConfig` type (src/lib/flows/types.ts), and the Flows
-- builder/engine have supported the 'export_order' node type since
-- that PR — but 045 never widened this CHECK constraint the way
-- migrations 016 (send_media) and 041 (ai_reply) did for their node
-- types. Net effect: saving a flow with an export_order node has been
-- silently impossible since 045 shipped — the INSERT/UPDATE fails
-- the CHECK, so no flow could ever actually export an order, even
-- though every other layer (types, builder UI, engine) treats it as
-- fully supported.
--
-- Same drop + recreate pattern as 016/041 (Postgres has no ADD VALUE
-- for a plain CHECK).
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
    'export_order'
  ));
