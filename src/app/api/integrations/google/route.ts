// ============================================================
// /api/integrations/google
//
//   GET    — this account's Google connection status (any member).
//            Never returns the encrypted refresh token.
//   DELETE — disconnect (admin+). Best-effort revoke on Google's side.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { isGoogleOAuthConfigured } from '@/lib/google-sheets/oauth';
import { decrypt } from '@/lib/whatsapp/encryption';
import { revokeRefreshToken } from '@/lib/google-sheets/oauth';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data, error } = await ctx.supabase
      .from('account_google_connections')
      .select('google_email')
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (error) {
      console.error('[GET /api/integrations/google] fetch error:', error);
      return NextResponse.json({ error: 'Failed to load connection status' }, { status: 500 });
    }

    return NextResponse.json({
      connected: !!data,
      email: data?.google_email ?? null,
      serverConfigured: isGoogleOAuthConfigured(),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE() {
  try {
    const ctx = await requireRole('admin');

    const { data } = await ctx.supabase
      .from('account_google_connections')
      .select('refresh_token_encrypted')
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (data?.refresh_token_encrypted) {
      try {
        await revokeRefreshToken(decrypt(data.refresh_token_encrypted));
      } catch (err) {
        console.warn('[DELETE /api/integrations/google] revoke failed (non-fatal):', err);
      }
    }

    const { error } = await ctx.supabase
      .from('account_google_connections')
      .delete()
      .eq('account_id', ctx.accountId);

    if (error) {
      console.error('[DELETE /api/integrations/google] delete error:', error);
      return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
