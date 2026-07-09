/**
 * Thin wrapper over the Sheets API v4 REST endpoints (values.get /
 * values.update / values.append) — deliberately not the full
 * `googleapis` SDK, which bundles every Google API and is much
 * heavier than this integration needs.
 *
 * Auth-agnostic on purpose: every call takes an explicit
 * `accessToken` rather than resolving one internally, since which
 * credential to use depends on the caller (a specific account's OAuth
 * connection — see `oauth.ts`), not on this module.
 */

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

class GoogleSheetsApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'GoogleSheetsApiError';
  }
}

function friendlyMessage(status: number, body: string): string {
  if (status === 403) {
    return 'Google rejected the request (403). Make sure the connected Google account has access to this spreadsheet.';
  }
  if (status === 404) {
    return 'Spreadsheet not found (404). Double-check it has not been deleted or unshared.';
  }
  if (status === 400 && /unable to parse range/i.test(body)) {
    return `Sheet tab not found. Check the tab name matches exactly (case-sensitive).`;
  }
  return `Google Sheets API error (${status}): ${body.slice(0, 300)}`;
}

async function authedFetch(
  accessToken: string,
  url: string,
  init?: RequestInit
): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GoogleSheetsApiError(res.status, friendlyMessage(res.status, body));
  }
  return res;
}

export async function getSheetValues(
  accessToken: string,
  spreadsheetId: string,
  range: string
): Promise<string[][]> {
  const res = await authedFetch(
    accessToken,
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`
  );
  const data = (await res.json()) as { values?: string[][] };
  return data.values ?? [];
}

export async function updateSheetValues(
  accessToken: string,
  spreadsheetId: string,
  range: string,
  values: (string | number)[][]
): Promise<void> {
  await authedFetch(
    accessToken,
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    { method: 'PUT', body: JSON.stringify({ values }) }
  );
}

/**
 * Appends rows after the last row with data in `range` — the correct
 * primitive for an order log: it never touches existing rows, unlike
 * `updateSheetValues` (which overwrites a fixed range).
 */
export async function appendSheetValues(
  accessToken: string,
  spreadsheetId: string,
  range: string,
  values: (string | number)[][]
): Promise<void> {
  await authedFetch(
    accessToken,
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ values }) }
  );
}
