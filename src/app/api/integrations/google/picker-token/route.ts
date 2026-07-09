// ============================================================
// GET /api/integrations/google/picker-token
//
// Mints a short-lived Google access token for the CURRENT account's
// connection, handed to the browser only so it can open the Google
// Picker widget. The refresh token itself never leaves the server.
// Admin+ (matches the write gate on product_sheet_configs), rate
// limited like every other admin action.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { getAccessTokenForAccount } from '@/lib/google-sheets/oauth';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function GET() {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(`admin:googlePickerToken:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const accessToken = await getAccessTokenForAccount(ctx.supabase, ctx.accountId);
    return NextResponse.json({ accessToken });
  } catch (err) {
    if (err instanceof Error && err.message.includes('has not connected a Google account')) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return toErrorResponse(err);
  }
}
