const SHEET_URL_RE = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;

/**
 * Accepts either a bare spreadsheet id or a full Google Sheets URL
 * (any of its tab/view variants) and returns just the id, so pasting
 * the browser address bar contents "just works".
 */
export function extractSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(SHEET_URL_RE);
  return match ? match[1] : trimmed;
}
