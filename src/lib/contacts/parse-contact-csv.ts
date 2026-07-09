/**
 * CSV parsing for the contacts import modal. Shared + unit-tested so
 * tag-column handling stays aligned with phone/name/email/company.
 */

export interface ParsedContactRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  address?: string;
  city?: string;
  department?: string;
  neighborhood?: string;
  /** Tag names from the optional `tags` column (comma/semicolon separated). */
  tagNames: string[];
}

/** Lowercase + strip diacritics so "Dirección" matches the "direccion" alias. */
function normalizeHeader(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** English + Spanish header names accepted for each field, normalized. */
const HEADER_ALIASES = {
  phone: ['phone', 'celular', 'telefono', 'numero'],
  name: ['name', 'nombre'],
  email: ['email', 'correo'],
  company: ['company', 'empresa'],
  address: ['address', 'direccion'],
  city: ['city', 'ciudad'],
  department: ['department', 'departamento', 'estado', 'state'],
  neighborhood: ['neighborhood', 'barrio'],
  tags: ['tags', 'etiquetas'],
} as const;

function findHeaderIndex(
  headers: string[],
  field: keyof typeof HEADER_ALIASES,
): number {
  for (const alias of HEADER_ALIASES[field]) {
    const idx = headers.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

/** Split a CSV cell into unique tag names (case-insensitive de-dupe). */
export function parseTagCell(value: string | undefined): string[] {
  if (!value?.trim()) return [];

  const seen = new Set<string>();
  const names: string[] = [];

  for (const part of value.split(/[,;]/)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  return names;
}

export interface ParseContactCsvResult {
  rows: ParsedContactRow[];
  /** True when the CSV header includes a `tags` column. */
  hasTagsColumn: boolean;
  /** True when the CSV header includes a `company` column. */
  hasCompanyColumn: boolean;
  /** True when the CSV header includes an `address`/`direccion` column. */
  hasAddressColumn: boolean;
  /** True when the CSV header includes a `city`/`ciudad` column. */
  hasCityColumn: boolean;
  /** True when the CSV header includes a `department`/`departamento` column. */
  hasDepartmentColumn: boolean;
  /** True when the CSV header includes a `neighborhood`/`barrio` column. */
  hasNeighborhoodColumn: boolean;
}

const EMPTY_RESULT: ParseContactCsvResult = {
  rows: [],
  hasTagsColumn: false,
  hasCompanyColumn: false,
  hasAddressColumn: false,
  hasCityColumn: false,
  hasDepartmentColumn: false,
  hasNeighborhoodColumn: false,
};

export function parseContactCsv(text: string): ParseContactCsvResult {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) {
    return EMPTY_RESULT;
  }

  const headers = lines[0]
    .split(',')
    .map((h) => normalizeHeader(h.trim().replace(/["']/g, '')));

  const phoneIdx = findHeaderIndex(headers, 'phone');
  if (phoneIdx === -1) {
    return EMPTY_RESULT;
  }

  const nameIdx = findHeaderIndex(headers, 'name');
  const emailIdx = findHeaderIndex(headers, 'email');
  const companyIdx = findHeaderIndex(headers, 'company');
  const addressIdx = findHeaderIndex(headers, 'address');
  const cityIdx = findHeaderIndex(headers, 'city');
  const departmentIdx = findHeaderIndex(headers, 'department');
  const neighborhoodIdx = findHeaderIndex(headers, 'neighborhood');
  const tagsIdx = findHeaderIndex(headers, 'tags');

  const rows: ParsedContactRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCsvLine(line);
    const cell = (idx: number): string | undefined =>
      idx >= 0 ? values[idx]?.replace(/["']/g, '').trim() || undefined : undefined;

    const phone = cell(phoneIdx);
    if (!phone) continue;

    rows.push({
      phone,
      name: cell(nameIdx),
      email: cell(emailIdx),
      company: cell(companyIdx),
      address: cell(addressIdx),
      city: cell(cityIdx),
      department: cell(departmentIdx),
      neighborhood: cell(neighborhoodIdx),
      tagNames:
        tagsIdx >= 0 ? parseTagCell(values[tagsIdx]?.replace(/["']/g, '')) : [],
    });
  }

  return {
    rows,
    hasTagsColumn: tagsIdx >= 0,
    hasCompanyColumn: companyIdx >= 0,
    hasAddressColumn: addressIdx >= 0,
    hasCityColumn: cityIdx >= 0,
    hasDepartmentColumn: departmentIdx >= 0,
    hasNeighborhoodColumn: neighborhoodIdx >= 0,
  };
}

/** Simple CSV line parse (handles quoted fields). */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}
