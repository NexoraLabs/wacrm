// ============================================================
// GET /api/integrations/google/connect
//
// Starts the "Connect with Google" flow. Admin+ only (mirrors the
// write gate on every other credential-like settings resource). Sets
// a short-lived, httpOnly CSRF nonce cookie, then redirects the
// browser to Google's consent screen — this is a real navigation, not
// a fetch, since it ends on Google's own domain.
// ============================================================

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import crypto from 'crypto';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { buildAuthUrl, isGoogleOAuthConfigured } from '@/lib/google-sheets/oauth';

export const OAUTH_STATE_COOKIE = 'google_oauth_state';

export async function GET() {
  try {
    await requireRole('admin');

    if (!isGoogleOAuthConfigured()) {
      return NextResponse.json(
        {
          error:
            'Google OAuth is not configured on this server. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.',
        },
        { status: 503 }
      );
    }

    const state = crypto.randomBytes(24).toString('hex');
    const cookieStore = await cookies();
    cookieStore.set(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 600, // 10 minutes — plenty for a consent-screen round trip.
      path: '/',
    });

    return NextResponse.redirect(buildAuthUrl(state));
  } catch (err) {
    return toErrorResponse(err);
  }
}
