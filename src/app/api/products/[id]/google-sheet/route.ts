// ============================================================
// /api/products/[id]/google-sheet
//
//   GET    — this product's connected sheet (if any), plus whether
//            the server has a Google service account configured and
//            whether the account's membership is currently active
//            (the feature gate — see `requireActiveSubscription`).
//   POST   — connect/update the spreadsheet id + tab name. Admin+,
//            AND an active membership once billing enforcement is
//            turned on (`BILLING_ENFORCEMENT_ENABLED=true`) — until
//            then this is a no-op check, per `src/lib/billing/gate.ts`.
//   DELETE — disconnect.
// ============================================================

import { NextResponse } from 'next/server';

import { requireActiveSubscription } from '@/lib/billing/gate';
import { getCurrentAccount, requireRole, toErrorResponse, ForbiddenError } from '@/lib/auth/account';
import { getServiceAccountEmail, isGoogleSheetsConfigured } from '@/lib/google-sheets/auth';
import { extractSpreadsheetId } from '@/lib/google-sheets/spreadsheet-id';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

type Params = { params: Promise<{ id: string }> };

const SAFE_COLUMNS = 'id, spreadsheet_id, sheet_name, last_exported_at';

async function membershipIsActive(accountId: string): Promise<boolean> {
  try {
    await requireActiveSubscription(accountId);
    return true;
  } catch (err) {
    if (err instanceof ForbiddenError) return false;
    throw err;
  }
}

async function verifyProductOwnership(
  supabase: Awaited<ReturnType<typeof getCurrentAccount>>['supabase'],
  accountId: string,
  productId: string
): Promise<boolean> {
  const { data } = await supabase
    .from('products')
    .select('id')
    .eq('id', productId)
    .eq('account_id', accountId)
    .maybeSingle();
  return !!data;
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id: productId } = await params;

    if (!(await verifyProductOwnership(ctx.supabase, ctx.accountId, productId))) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    const { data, error } = await ctx.supabase
      .from('product_sheet_configs')
      .select(SAFE_COLUMNS)
      .eq('product_id', productId)
      .maybeSingle();

    if (error) {
      console.error('[GET /api/products/[id]/google-sheet] fetch error:', error);
      return NextResponse.json({ error: 'Failed to load configuration' }, { status: 500 });
    }

    return NextResponse.json({
      config: data ?? null,
      serverConfigured: isGoogleSheetsConfigured(),
      serviceAccountEmail: getServiceAccountEmail(),
      membershipActive: await membershipIsActive(ctx.accountId),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const { id: productId } = await params;

    const limit = checkRateLimit(`admin:productSheetSave:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    // The membership gate. No-op today (BILLING_ENFORCEMENT_ENABLED is
    // unset) — every account currently qualifies. Once enforcement is
    // turned on, a lapsed account gets a 403 here.
    await requireActiveSubscription(ctx.accountId);

    if (!isGoogleSheetsConfigured()) {
      return NextResponse.json(
        {
          error:
            'Google Sheets sync is not configured on this server. Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.',
        },
        { status: 503 }
      );
    }

    if (!(await verifyProductOwnership(ctx.supabase, ctx.accountId, productId))) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as {
      spreadsheetId?: unknown;
      sheetName?: unknown;
    } | null;

    const rawId = typeof body?.spreadsheetId === 'string' ? body.spreadsheetId : '';
    const spreadsheetId = extractSpreadsheetId(rawId);
    if (!spreadsheetId) {
      return NextResponse.json(
        { error: 'spreadsheetId (or the sheet URL) is required' },
        { status: 400 }
      );
    }

    const sheetName =
      typeof body?.sheetName === 'string' && body.sheetName.trim()
        ? body.sheetName.trim()
        : 'Orders';

    const { data, error } = await ctx.supabase
      .from('product_sheet_configs')
      .upsert(
        {
          account_id: ctx.accountId,
          product_id: productId,
          user_id: ctx.userId,
          spreadsheet_id: spreadsheetId,
          sheet_name: sheetName,
        },
        { onConflict: 'product_id' }
      )
      .select(SAFE_COLUMNS)
      .single();

    if (error || !data) {
      console.error('[POST /api/products/[id]/google-sheet] upsert error:', error);
      return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 });
    }

    return NextResponse.json({ config: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const { id: productId } = await params;

    if (!(await verifyProductOwnership(ctx.supabase, ctx.accountId, productId))) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    const { error } = await ctx.supabase
      .from('product_sheet_configs')
      .delete()
      .eq('product_id', productId);

    if (error) {
      console.error('[DELETE /api/products/[id]/google-sheet] delete error:', error);
      return NextResponse.json({ error: 'Failed to remove configuration' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
