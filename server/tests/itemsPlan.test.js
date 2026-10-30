// Support Log Item_Master → company plans (pure, no DB).
const { buildItemsPlan, checkCompanyGuard } = require('../modules/sync/itemsPlan');

const row = (Company_Id, Item_Id, Category, Item, Sub_Item, extra = {}) => ({
  Company_Id, Item_Id, Category, Item, Sub_Item, Tag: '0', Price: null, Qty: 0, Qty_Multiples: 0, ...extra,
});

describe('buildItemsPlan', () => {
  const rows = [
    row(2, 11, ' Electrical ', 'Cable', 'lay'),
    row(2, 10, 'Electrical', 'Cable', 'Lay'), // same as 11 in another case: the lower Item_Id wins
    row(2, 12, 'Cleaning', 'Other_Cleaning', 'Other'),
    row(1, 1, 'Hardware', 'Printer', 'Paper jam', { Tag: '1' }),
    row(1, 2, 'Telecommunication', 'Intercom', 'Dead'),
    row(3, 20, 'Stationary', 'Cello Tape', '3 inch', { Price: '25.50', Qty: 4, Qty_Multiples: 6 }),
    row(3, 21, 'Cutlery / Crockery', 'Cup Saucer', 'Pcs ( 4)', { Price: 'NULL', Qty: 5, Qty_Multiples: 0 }),
    row(3, 22, 'Courier Service', 'Other_Courier', 'Other', { Qty: 3, Qty_Multiples: 1 }),
    row(3, 23, 'Stationary', 'Cello Tape', '3 Inch '), // duplicate of 20
    row(3, 24, 'Stationary', 'Marker', 'Marker'),
    row(9, 99, 'X', 'Y', 'Z'),
    row(2, 13, '', 'Door', 'Hinges'),
  ];

  test('cleans, de-duplicates, maps each company', () => {
    const p = buildItemsPlan(rows);
    expect(p.counts).toEqual({ sourceRows: 12, validRows: 8, skippedRows: 4 });
    expect(p.skipped.other_company).toBe(1);

    const s = p.companies.SIYANAAT;
    expect(s.entries.map((e) => [e.legacyId, e.category, e.item, e.problem])).toEqual([
      [10, 'Electrical', 'Cable', 'Lay'],
      [12, 'Cleaning', 'Other', 'Other'],
    ]);
    expect(s.duplicates).toEqual([{ legacyId: 11, name: 'Electrical > Cable > Lay' }]);
    expect(s.errors).toEqual([{ legacyId: 13, message: 'Item_Id, Category and Item are required.' }]);

    const a = p.companies.AVIT;
    expect(a.entries.map((e) => [e.category, e.item, e.active])).toEqual([
      ['Printer / Scanner', 'Printer', false],
      ['Telephone / Intercom', 'Intercom', true],
    ]);

    const t = Object.fromEntries(p.companies.TANZEEM.entries.map((e) => [e.legacyId, e]));
    expect(t[20]).toMatchObject({ group: 'Stationery', name: 'Cello Tape — 3 inch', kind: 'supply', price: 25.5, packSize: 6, stock: 24 });
    expect(t[21]).toMatchObject({ name: 'Cup Saucer — Pcs (4)', price: null, packSize: 1, stock: 5 });
    expect(t[22]).toMatchObject({ name: 'Other (Courier Service)', kind: 'service', stock: null });
    expect(t[24]).toMatchObject({ name: 'Marker' });
    expect(t[23]).toBeUndefined();
  });

  test('only the chosen companies; hash changes with the content', () => {
    const p = buildItemsPlan(rows, { companies: ['TANZEEM'] });
    expect(Object.keys(p.companies)).toEqual(['TANZEEM']);
    expect(p.skipped.not_selected).toBe(6);
    const h1 = buildItemsPlan([row(2, 1, 'A', 'B', 'C')]).companies.SIYANAAT.entries[0].hash;
    const h2 = buildItemsPlan([row(2, 1, 'A', 'B', 'D')]).companies.SIYANAAT.entries[0].hash;
    expect(h1).not.toBe(h2);
  });
});

describe('checkCompanyGuard', () => {
  test('0 rows blocked even when forced; under half blocked unless forced', () => {
    expect(checkCompanyGuard('AVIT', 0, 100, true).ok).toBe(false);
    expect(checkCompanyGuard('AVIT', 40, 100, false).ok).toBe(false);
    expect(checkCompanyGuard('AVIT', 40, 100, true).ok).toBe(true);
    expect(checkCompanyGuard('AVIT', 60, 100, false).ok).toBe(true);
    expect(checkCompanyGuard('AVIT', 5, undefined, false).ok).toBe(true);
  });
});
