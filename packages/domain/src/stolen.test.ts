import { describe, expect, it } from 'vitest';
import { agencyHandles, applyEvent, availableEvents, checkRule, defaultItemTypes, luhnValid, normalizeIdentifier, reachableStates, stolenMachine, validateIdentifier, vinCheckValid } from './index';

const type = (code: string) => defaultItemTypes.find((t) => t.code === code)!;

describe('item identifiers', () => {
  it('checks an IMEI: 15 digits with a Luhn check digit', () => {
    expect(luhnValid('490154203237518')).toBe(true);
    expect(validateIdentifier(type('phone'), '49-015420-323751-8')).toEqual({ ok: true, value: '490154203237518' });
    expect(validateIdentifier(type('phone'), '490154203237519')).toMatchObject({ ok: false, message: 'This is not a valid IMEI. Check each digit again.' });
    expect(validateIdentifier(type('phone'), '49015420323751')).toMatchObject({ ok: false, message: 'The IMEI is 15 characters long. This one has 14.' });
    expect(validateIdentifier(type('phone'), '49015420323751A')).toMatchObject({ ok: false, message: 'The IMEI has digits only.' });
    expect(validateIdentifier(type('phone'), '  ')).toMatchObject({ ok: false, message: 'Enter the IMEI.' });
  });

  it('checks a VIN: 17 characters without I, O or Q', () => {
    expect(validateIdentifier(type('car'), '1hgcm82633a004352')).toEqual({ ok: true, value: '1HGCM82633A004352' });
    expect(validateIdentifier(type('car'), '1HGCM82633A00435O')).toMatchObject({ ok: false, message: 'The Chassis number (VIN) has letters and numbers only (no I, O or Q).' });
    expect(validateIdentifier(type('car'), '1HGCM82633A0043')).toMatchObject({ ok: false });
    expect(vinCheckValid('1HGCM82633A004352')).toBe(true);
    expect(vinCheckValid('1HGCM82643A004352')).toBe(false);
  });

  it('keeps one clean form and honours an admin pattern', () => {
    expect(normalizeIdentifier(' c02-xk.1/9 ')).toBe('C02XK19');
    const rule = { minLength: 6, maxLength: 12, charset: 'alnum' as const, checksum: 'none' as const, pattern: '^SN' };
    expect(validateIdentifier({ identifierLabel: 'Serial number', rule }, 'SN12345').ok).toBe(true);
    expect(validateIdentifier({ identifierLabel: 'Serial number', rule }, 'AB12345')).toMatchObject({ ok: false, message: 'This does not look like a Serial number. Check it again.' });
  });

  it('refuses rules that cannot work', () => {
    expect(checkRule({ minLength: 10, maxLength: 5, charset: 'digits', checksum: 'none' })).toMatch(/shortest/);
    expect(checkRule({ minLength: 15, maxLength: 15, charset: 'alnum', checksum: 'luhn' })).toMatch(/Luhn/);
    expect(checkRule({ minLength: 5, maxLength: 9, charset: 'alnum', checksum: 'none', pattern: '([' })).toMatch(/regular expression/);
    for (const t of defaultItemTypes) expect(checkRule(t.rule)).toBeNull();
  });
});

describe('stolen item machine', () => {
  it('reaches every state', () => {
    expect([...reachableStates(stolenMachine)].sort()).toEqual(['closed', 'investigating', 'located', 'recovered', 'reported', 'returned', 'withdrawn']);
  });
  it('lets the police recover it and the owner withdraw it', () => {
    expect(availableEvents(stolenMachine, 'reported', 'agency_admin').sort()).toEqual(['close', 'investigate', 'locate']);
    expect(applyEvent(stolenMachine, 'recovered', 'withdraw', 'owner').ok).toBe(false);
    expect(applyEvent(stolenMachine, 'located', 'recover', 'owner')).toMatchObject({ ok: false, code: 'actor_not_allowed' });
  });
  it('goes to the police only', () => {
    expect(agencyHandles('police').stolen).toBe(true);
    expect(agencyHandles('roads').stolen).toBe(false);
  });
});
