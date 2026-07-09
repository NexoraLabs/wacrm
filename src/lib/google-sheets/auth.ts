import { JWT } from 'google-auth-library';

/**
 * One shared Google Cloud service account authenticates Sheets access
 * for every account on this instance — accounts share their own
 * spreadsheet with this service account's email rather than going
 * through per-account OAuth. Keeps the integration to "paste a
 * spreadsheet id, share it, click sync" with no consent screen.
 */

let cachedClient: JWT | null = null;

function getCredentials(): { email: string; key: string } | null {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!email || !rawKey) return null;
  // .env values can't hold real newlines; the PEM is stored with
  // literal "\n" escapes that need converting back before parsing.
  const key = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;
  return { email, key };
}

export function isGoogleSheetsConfigured(): boolean {
  return getCredentials() !== null;
}

export function getServiceAccountEmail(): string | null {
  return getCredentials()?.email ?? null;
}

function getClient(): JWT {
  if (cachedClient) return cachedClient;
  const creds = getCredentials();
  if (!creds) {
    throw new Error(
      'Google Sheets sync is not configured on this server (missing GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY).'
    );
  }
  cachedClient = new JWT({
    email: creds.email,
    key: creds.key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return cachedClient;
}

/** Access token for the Sheets API v4 REST calls — cached/refreshed by google-auth-library internally. */
export async function getAccessToken(): Promise<string> {
  const client = getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Failed to obtain a Google access token');
  return token;
}
