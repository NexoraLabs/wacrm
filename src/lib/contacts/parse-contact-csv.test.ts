import { describe, expect, it } from 'vitest';
import { parseContactCsv, parseTagCell } from './parse-contact-csv';

describe('parseTagCell', () => {
  it('splits comma-separated tags and trims whitespace', () => {
    expect(parseTagCell(' VIP , Lead ,  ')).toEqual(['VIP', 'Lead']);
  });

  it('splits semicolon-separated tags', () => {
    expect(parseTagCell('VIP; Lead; Customer')).toEqual([
      'VIP',
      'Lead',
      'Customer',
    ]);
  });

  it('de-dupes case-insensitively', () => {
    expect(parseTagCell('vip, VIP, Lead')).toEqual(['vip', 'Lead']);
  });

  it('returns empty for blank values', () => {
    expect(parseTagCell('')).toEqual([]);
    expect(parseTagCell(undefined)).toEqual([]);
  });
});

describe('parseContactCsv', () => {
  it('parses optional tags column', () => {
    const csv = `phone,name,tags
+15551234567,Alice,"VIP, Lead"
+15559876543,Bob,Customer`;

    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: true,
      hasCompanyColumn: false,
      hasAddressColumn: false,
      hasCityColumn: false,
      hasDepartmentColumn: false,
      hasNeighborhoodColumn: false,
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: ['VIP', 'Lead'],
        },
        {
          phone: '+15559876543',
          name: 'Bob',
          email: undefined,
          company: undefined,
          tagNames: ['Customer'],
        },
      ],
    });
  });

  it('returns empty tagNames when tags column is absent', () => {
    const csv = `phone,name
+15551234567,Alice`;

    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: false,
      hasCompanyColumn: false,
      hasAddressColumn: false,
      hasCityColumn: false,
      hasDepartmentColumn: false,
      hasNeighborhoodColumn: false,
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: [],
        },
      ],
    });
  });

  it('recognizes Spanish header aliases for phone/name/address fields', () => {
    const csv = `celular,nombre,direccion,ciudad,departamento,barrio
+573001234567,Juana Pérez,Calle 10 # 20-30,Bogotá,Cundinamarca,Chapinero`;

    const result = parseContactCsv(csv);
    expect(result.hasAddressColumn).toBe(true);
    expect(result.hasCityColumn).toBe(true);
    expect(result.hasDepartmentColumn).toBe(true);
    expect(result.hasNeighborhoodColumn).toBe(true);
    expect(result.rows).toEqual([
      {
        phone: '+573001234567',
        name: 'Juana Pérez',
        email: undefined,
        company: undefined,
        address: 'Calle 10 # 20-30',
        city: 'Bogotá',
        department: 'Cundinamarca',
        neighborhood: 'Chapinero',
        tagNames: [],
      },
    ]);
  });

  it('recognizes an accented "Dirección" header', () => {
    const csv = `phone,Dirección
+15551234567,123 Main St`;

    const result = parseContactCsv(csv);
    expect(result.hasAddressColumn).toBe(true);
    expect(result.rows[0].address).toBe('123 Main St');
  });
});
