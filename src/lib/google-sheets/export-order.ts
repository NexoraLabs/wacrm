import type { SupabaseClient } from '@supabase/supabase-js';

import { requireActiveSubscription } from '@/lib/billing/gate';
import type { ExportOrderNodeConfig, FlowRunRow } from '@/lib/flows/types';
import { appendSheetValues, getSheetValues, updateSheetValues } from './client';

const HEADER_ROW = [
  'Timestamp',
  'Contact name',
  'Phone',
  'Address',
  'City',
  'Department',
  'Neighborhood',
  'Product',
  'Quantity',
];

/**
 * Appends one order row (shipping data + product + quantity) to the
 * product's connected Google Sheet, called from the flow engine's
 * `export_order` node. No-op when the product has no sheet connected
 * yet — a flow author may wire this node up before connecting one.
 * Otherwise throws on failure; the engine catches it, logs it as a
 * non-fatal flow_run_event, and advances the run regardless — a
 * missing contact, a lapsed membership, or a Google API hiccup should
 * never strand the customer mid-flow.
 */
export async function exportOrderRow(
  db: SupabaseClient,
  run: FlowRunRow,
  cfg: ExportOrderNodeConfig
): Promise<void> {
  const { data: sheetConfig, error: sheetConfigError } = await db
    .from('product_sheet_configs')
    .select('id, spreadsheet_id, sheet_name')
    .eq('product_id', cfg.product_id)
    .eq('account_id', run.account_id)
    .maybeSingle();
  if (sheetConfigError) throw sheetConfigError;
  if (!sheetConfig) return;

  // Membership gate. No-op today (BILLING_ENFORCEMENT_ENABLED is
  // unset) — once enforcement is turned on, a lapsed account's
  // exports stop here (ForbiddenError propagates to the engine's
  // catch, same as any other failure).
  await requireActiveSubscription(run.account_id);

  const [{ data: contact, error: contactError }, { data: product, error: productError }] =
    await Promise.all([
      db.from('contacts').select('name, phone').eq('id', run.contact_id!).maybeSingle(),
      db.from('products').select('name').eq('id', cfg.product_id).maybeSingle(),
    ]);
  if (contactError) throw contactError;
  if (productError) throw productError;

  const vars = run.vars ?? {};
  const readVar = (key: string | undefined): string => {
    if (!key) return '';
    const v = vars[key];
    if (v == null) return '';
    return typeof v === 'string' ? v : String(v);
  };

  const row = [
    new Date().toISOString(),
    contact?.name ?? '',
    contact?.phone ?? '',
    readVar(cfg.address_var_key),
    readVar(cfg.city_var_key),
    readVar(cfg.department_var_key),
    readVar(cfg.neighborhood_var_key),
    product?.name ?? '',
    readVar(cfg.quantity_var_key) || '1',
  ];

  const { spreadsheet_id: spreadsheetId, sheet_name: sheetName } = sheetConfig;

  // Self-describing sheet: write the header once, the first time a
  // row is exported to an empty tab.
  const firstCell = await getSheetValues(spreadsheetId, `${sheetName}!A1:A1`);
  if (firstCell.length === 0) {
    await updateSheetValues(spreadsheetId, `${sheetName}!A1`, [HEADER_ROW]);
  }

  await appendSheetValues(spreadsheetId, `${sheetName}!A:Z`, [row]);

  await db
    .from('product_sheet_configs')
    .update({ last_exported_at: new Date().toISOString() })
    .eq('id', sheetConfig.id);
}
