import { describe, expect, it } from 'vitest';
import { quoteSheetName } from './export-order';

describe('quoteSheetName', () => {
  it('wraps a sheet name containing a space in single quotes', () => {
    expect(quoteSheetName('Hoja 1')).toBe("'Hoja 1'");
  });

  it('wraps a plain single-word name too (harmless, still valid A1 notation)', () => {
    expect(quoteSheetName('Orders')).toBe("'Orders'");
  });

  it('doubles an embedded single quote', () => {
    expect(quoteSheetName("Pedro's Orders")).toBe("'Pedro''s Orders'");
  });
});
