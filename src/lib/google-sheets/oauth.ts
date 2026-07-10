import { OAuth2Client } from 'google-auth-library';
import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';

/**
 * Per-account Google OAuth — replaces the earlier shared-service-
 * account design. Each account connects its own Google account once
 * (Settings → Google → "Connect with Google"); we store the
 * long-lived refresh token (encrypted) and mint short-lived access
 * tokens from it on demand, per account, rather than every product
 * owner sharing their sheet with one fixed service-account email.
 */

const SCOPES = [
  // openid + email get an id_token with an email claim, so the
  // connected account can be shown by name in Settings → Google —
  // without these, Google issues no id_token at all and the stored
  // connection has no display email (harmless functionally, just
  // shows as "unknown").
  'openid',
  'email',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

function getCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function isGoogleOAuthConfigured(): boolean {
  return getCredentials() !== null;
}

function redirectUri(): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL;
  if (!base) {
    throw new Error(
      'NEXT_PUBLIC_SITE_URL must be set to build the Google OAuth redirect URI.'
    );
  }
  return `${base.replace(/\/$/, '')}/api/integrations/google/callback`;
}

function newClient(): OAuth2Client {
  const creds = getCredentials();
  if (!creds) {
    throw new Error(
      'Google OAuth is not configured on this server (missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET).'
    );
  }
  const uri = redirectUri();
  // Logged deliberately: a redirect_uri that doesn't exactly match the
  // one registered in the Google Cloud OAuth client (e.g. NEXT_PUBLIC_
  // SITE_URL still pointing at a platform-assigned host instead of the
  // real domain) fails as an opaque redirect_uri_mismatch on Google's
  // side with nothing in our own logs — this line is the fast way to
  // confirm what this deployment is actually sending.
  console.log('[google oauth] redirect_uri:', uri);
  return new OAuth2Client(creds.clientId, creds.clientSecret, uri);
}

/** Google's consent screen URL. `state` is the CSRF nonce, verified against a cookie by the callback route. */
export function buildAuthUrl(state: string): string {
  const client = newClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state,
  });
}

export interface ExchangedTokens {
  refreshToken: string;
  accessToken: string;
  email: string | null;
}

/** Exchanges the callback's `code` for tokens, and resolves the connected Google account's email for display. */
export async function exchangeCodeForTokens(code: string): Promise<ExchangedTokens> {
  const client = newClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      "Google didn't return a refresh token. This usually means the account already granted access before — revoke wacrm's access at https://myaccount.google.com/permissions and try connecting again."
    );
  }
  if (!tokens.access_token) {
    throw new Error('Google did not return an access token.');
  }

  let email: string | null = null;
  if (tokens.id_token) {
    try {
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: getCredentials()!.clientId,
      });
      email = ticket.getPayload()?.email ?? null;
    } catch (err) {
      console.error('[oauth] failed to decode id_token for email:', err);
    }
  }

  return { refreshToken: tokens.refresh_token, accessToken: tokens.access_token, email };
}

/**
 * Mints a fresh access token for `accountId` from its stored,
 * encrypted refresh token. Throws if the account has never connected
 * Google — callers (the flow engine, the picker-token route) treat
 * that as a normal "not connected yet" failure.
 */
export async function getAccessTokenForAccount(
  db: SupabaseClient,
  accountId: string
): Promise<string> {
  const { data, error } = await db
    .from('account_google_connections')
    .select('refresh_token_encrypted')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error('This account has not connected a Google account yet.');
  }

  const refreshToken = decrypt(data.refresh_token_encrypted);
  const client = newClient();
  client.setCredentials({ refresh_token: refreshToken });

  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Failed to obtain a Google access token');
  return token;
}

/** Best-effort revoke on disconnect — non-fatal if Google rejects it (e.g. already revoked). */
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  try {
    const client = newClient();
    await client.revokeToken(refreshToken);
  } catch (err) {
    console.warn('[oauth] token revocation failed (non-fatal):', err);
  }
}
