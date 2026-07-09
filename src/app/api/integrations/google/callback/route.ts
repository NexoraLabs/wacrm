// ============================================================
// GET /api/integrations/google/callback
//
// Google redirects here after the user grants (or denies) consent.
// Verifies the CSRF nonce against the cookie `/connect` set, exchanges
// the code for tokens, stores the encrypted refresh token against the
// CURRENT session's account (not anything derived from `state` —
// `state` is only the CSRF check), and redirects back into the app.
// ============================================================

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

import { requireRole } from '@/lib/auth/account';
import { exchangeCodeForTokens } from '@/lib/google-sheets/oauth';
import { encrypt } from '@/lib/whatsapp/encryption';
import { OAUTH_STATE_COOKIE } from '../connect/route';

function settingsRedirect(request: Request, query: string): NextResponse {
  const url = new URL('/settings', request.url);
  url.search = query;
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const expectedState = cookieStore.get(OAUTH_STATE_COOKIE)?.value;
  cookieStore.delete(OAUTH_STATE_COOKIE);

  const { searchParams } = new URL(request.url);
  const error = searchParams.get('error');
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  if (error) {
    return settingsRedirect(request, `?tab=google&google_error=${encodeURIComponent(error)}`);
  }
  if (!code || !state || !expectedState || state !== expectedState) {
    return settingsRedirect(request, '?tab=google&google_error=invalid_state');
  }

  try {
    const ctx = await requireRole('admin');

    const { refreshToken, email } = await exchangeCodeForTokens(code);

    const { error: upsertError } = await ctx.supabase
      .from('account_google_connections')
      .upsert(
        {
          account_id: ctx.accountId,
          user_id: ctx.userId,
          google_email: email,
          refresh_token_encrypted: encrypt(refreshToken),
        },
        { onConflict: 'account_id' }
      );
    if (upsertError) {
      console.error('[google/callback] upsert error:', upsertError);
      return settingsRedirect(request, '?tab=google&google_error=save_failed');
    }

    return settingsRedirect(request, '?tab=google&connected=1');
  } catch (err) {
    console.error('[google/callback] error:', err);
    return settingsRedirect(request, '?tab=google&google_error=exchange_failed');
  }
}
