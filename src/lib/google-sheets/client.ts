import { getAccessToken } from './auth';

/**
 * Thin wrapper over the Sheets API v4 REST endpoints (values.get /
 * values.update / values.append) — deliberately not the full
 * `googleapis` SDK, which bundles every Google API and is much
 * heavier than this integration needs.
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
    return 'Google rejected the request (403). Make sure the spreadsheet is shared with the service account email (Editor access).';
  }
  if (status === 404) {
    return 'Spreadsheet not found (404). Double-check the spreadsheet id and that it has not been deleted.';
  }
  if (status === 400 && /unable to parse range/i.test(body)) {
    return `Sheet tab not found. Check the tab name matches exactly (case-sensitive).`;
  }
  return `Google Sheets API error (${status}): ${body.slice(0, 300)}`;
}

async function authedFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${token}`,
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
  spreadsheetId: string,
  range: string
): Promise<string[][]> {
  const res = await authedFetch(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`
  );
  const data = (await res.json()) as { values?: string[][] };
  return data.values ?? [];
}

export async function updateSheetValues(
  spreadsheetId: string,
  range: string,
  values: (string | number)[][]
): Promise<void> {
  await authedFetch(
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
  spreadsheetId: string,
  range: string,
  values: (string | number)[][]
): Promise<void> {
  await authedFetch(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ values }) }
  );
}
