import type { SupabaseClient } from '@supabase/supabase-js';

import { requireActiveSubscription } from '@/lib/billing/gate';
import type { ExportOrderNodeConfig, FlowRunRow } from '@/lib/flows/types';
import { appendSheetValues, getSheetValues, updateSheetValues } from './client';
import { getAccessTokenForAccount } from './oauth';

/**
 * Field keys we know how to fill, and the header names (English +
 * Spanish, normalized) a merchant's own sheet might use for each.
 * Deliberately does NOT alias "estado" to department — on an orders
 * sheet "Estado" reads as order status, not the geographic
 * department, so that column is left for the merchant to manage
 * manually rather than risk writing the wrong thing into it.
 */
const ORDER_FIELD_ALIASES = {
  timestamp: ['fecha', 'date', 'timestamp'],
  name: ['cliente', 'nombre', 'name', 'client'],
  phone: ['whatsapp', 'telefono', 'celular', 'phone', 'numero'],
  address: ['direccion', 'address'],
  city: ['ciudad', 'city'],
  department: ['departamento', 'department', 'state'],
  neighborhood: ['barrio', 'neighborhood'],
  product: ['producto', 'product'],
  quantity: ['cantidad', 'quantity', 'qty'],
} as const;

type OrderField = keyof typeof ORDER_FIELD_ALIASES;

/** Default header written only when the sheet's tab is completely empty. */
const DEFAULT_HEADER_ROW = [
  'Fecha',
  'Cliente',
  'WhatsApp',
  'Direccion',
  'Ciudad',
  'Departamento',
  'Barrio',
  'Producto',
  'Cantidad',
];

/** Lowercase + strip diacritics, so "Dirección" matches "direccion". */
function normalizeHeader(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

function findColumnIndex(headers: string[], field: OrderField): number {
  for (const alias of ORDER_FIELD_ALIASES[field]) {
    const idx = headers.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

/**
 * Appends one order row (shipping data + product + quantity) to the
 * product's connected Google Sheet, called from the flow engine's
 * `export_order` node. Respects whatever column layout the merchant's
 * own sheet already has — matches by header name (English or
 * Spanish) rather than forcing a fixed column order, so a pre-made
 * template like "Fecha | Cliente | WhatsApp | Producto | Cantidad |
 * Total | Ciudad | Departamento | Barrio | Direccion | Estado" gets
 * each value in the right place and leaves merchant-managed columns
 * (Total, Estado) untouched. Only writes a default header when the
 * tab is completely empty.
 *
 * No-op when the product has no sheet connected yet — a flow author
 * may wire this node up before connecting one. Otherwise throws on
 * failure; the engine catches it, logs it as a non-fatal
 * flow_run_event, and advances the run regardless — a missing
 * contact, a lapsed membership, or a Google API hiccup should never
 * strand the customer mid-flow.
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

  const values: Record<OrderField, string> = {
    timestamp: new Date().toISOString(),
    name: contact?.name ?? '',
    phone: contact?.phone ?? '',
    address: readVar(cfg.address_var_key),
    city: readVar(cfg.city_var_key),
    department: readVar(cfg.department_var_key),
    neighborhood: readVar(cfg.neighborhood_var_key),
    product: product?.name ?? '',
    quantity: readVar(cfg.quantity_var_key) || '1',
  };

  const { spreadsheet_id: spreadsheetId, sheet_name: sheetName } = sheetConfig;
  const accessToken = await getAccessTokenForAccount(db, run.account_id);

  const headerRowRaw = await getSheetValues(accessToken, spreadsheetId, `${sheetName}!1:1`);
  let headers = (headerRowRaw[0] ?? []).map((h) => normalizeHeader(String(h ?? '')));

  if (headers.length === 0) {
    // Empty tab — write a default header the first time a row lands,
    // in the same field order as ORDER_FIELD_ALIASES/DEFAULT_HEADER_ROW.
    await updateSheetValues(accessToken, spreadsheetId, `${sheetName}!A1`, [DEFAULT_HEADER_ROW]);
    headers = DEFAULT_HEADER_ROW.map(normalizeHeader);
  }

  const row: string[] = [];
  for (const field of Object.keys(ORDER_FIELD_ALIASES) as OrderField[]) {
    const idx = findColumnIndex(headers, field);
    if (idx === -1) continue; // No matching column — leave it out, don't guess a position.
    row[idx] = values[field];
  }
  for (let i = 0; i < row.length; i++) {
    if (row[i] === undefined) row[i] = '';
  }

  await appendSheetValues(accessToken, spreadsheetId, `${sheetName}!A:Z`, [row]);

  await db
    .from('product_sheet_configs')
    .update({ last_exported_at: new Date().toISOString() })
    .eq('id', sheetConfig.id);
}
