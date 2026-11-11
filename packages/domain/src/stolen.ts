// Stolen-item registry: owners register what they own, report it stolen, and anyone about to buy a
// used car, phone or laptop checks its identifier first. Item types (and how each identifier is
// checked) are set by platform admins; these rules are shared by the API, the app and the dashboard.
import { defineMachine } from './machine';

/** How an item type's unique identifier is checked. Platform admins set this per type. */
export interface IdentifierRule {
  minLength: number;
  maxLength: number;
  /** digits: 0-9. alnum: letters and digits. vin: letters and digits without I, O and Q. */
  charset: 'digits' | 'alnum' | 'vin';
  /** luhn: the last digit is a Luhn check digit (IMEI). vin: the 9th character is the ISO 3779 check digit. */
  checksum: 'none' | 'luhn' | 'vin';
  /** Optional extra pattern the cleaned identifier must match (a JavaScript regular expression). */
  pattern?: string | null;
}

/** A document the owner gives as proof (receipt, vehicle papers). Required ones show as missing until added. */
export interface ItemDocument {
  code: string;
  label: string;
  required: boolean;
}

export interface ItemTypeDef {
  code: string;
  label: string;
  icon: string;
  identifierLabel: string;
  identifierHint: string;
  rule: IdentifierRule;
  documents: ItemDocument[];
}

/** The built-in types the first migration seeds; admins add more from the dashboard. */
export const defaultItemTypes: ItemTypeDef[] = [
  {
    code: 'phone',
    label: 'Phone',
    icon: 'phone',
    identifierLabel: 'IMEI',
    identifierHint: 'Dial *#06# to see it. 15 digits. Phones with two SIMs have two; use the first.',
    rule: { minLength: 15, maxLength: 15, charset: 'digits', checksum: 'luhn' },
    documents: [{ code: 'receipt', label: 'Receipt or proof of purchase', required: true }],
  },
  {
    code: 'car',
    label: 'Car',
    icon: 'road',
    identifierLabel: 'Chassis number (VIN)',
    identifierHint: '17 letters and numbers, on the dashboard by the windscreen and on the vehicle papers.',
    rule: { minLength: 17, maxLength: 17, charset: 'vin', checksum: 'none' },
    documents: [
      { code: 'ownership', label: 'Proof of ownership (vehicle licence)', required: true },
      { code: 'receipt', label: 'Purchase receipt', required: false },
    ],
  },
  {
    code: 'laptop',
    label: 'Laptop',
    icon: 'article',
    identifierLabel: 'Serial number',
    identifierHint: 'On a sticker under the laptop, or in its settings under About.',
    rule: { minLength: 5, maxLength: 30, charset: 'alnum', checksum: 'none' },
    documents: [{ code: 'receipt', label: 'Receipt or proof of purchase', required: true }],
  },
];

/** People type identifiers with spaces, dashes and lower case; the registry keeps one clean form. */
export const normalizeIdentifier = (raw: string) => raw.toUpperCase().replace(/[\s\-./]/g, '');

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// ISO 3779 transliteration: A=1 … H=8, J=1 … N=5, P=7, R=9, S=2 … Z=9.
const VIN_LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ';
const VIN_LETTER_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4, 5, 7, 9, 2, 3, 4, 5, 6, 7, 8, 9];
const VIN_VALUE: Record<string, number> = Object.fromEntries([...VIN_LETTERS].map((ch, i) => [ch, VIN_LETTER_VALUES[i]!]));
const VIN_WEIGHT = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** ISO 3779 check digit (9th character). Only North American VINs must carry one. */
export function vinCheckValid(vin: string): boolean {
  if (vin.length !== 17) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i]!;
    const v = /\d/.test(ch) ? Number(ch) : VIN_VALUE[ch];
    if (v == null) return false;
    sum += v * VIN_WEIGHT[i]!;
  }
  const r = sum % 11;
  return vin[8] === (r === 10 ? 'X' : String(r));
}

const CHARSET: Record<IdentifierRule['charset'], RegExp> = { digits: /^\d+$/, alnum: /^[A-Z0-9]+$/, vin: /^[A-HJ-NPR-Z0-9]+$/ };

/** Whether an admin-written rule is usable: sane lengths and a pattern that compiles. */
export function checkRule(rule: IdentifierRule): string | null {
  if (!Number.isInteger(rule.minLength) || !Number.isInteger(rule.maxLength) || rule.minLength < 3 || rule.maxLength > 64) return 'Lengths must be whole numbers between 3 and 64.';
  if (rule.minLength > rule.maxLength) return 'The shortest length cannot be more than the longest.';
  if (rule.checksum === 'luhn' && rule.charset !== 'digits') return 'A Luhn check needs digits only.';
  if (rule.checksum === 'vin' && (rule.charset !== 'vin' || rule.minLength !== 17 || rule.maxLength !== 17)) return 'A VIN check digit needs the VIN character set and exactly 17 characters.';
  if (rule.pattern) {
    try {
      new RegExp(rule.pattern);
    } catch {
      return 'The pattern is not a valid regular expression.';
    }
  }
  return null;
}

/**
 * Cleans and checks an identifier against its type. The message names the identifier the way the
 * type does ("IMEI", "Chassis number (VIN)"), so the app and the API say the same thing.
 */
export function validateIdentifier(t: Pick<ItemTypeDef, 'identifierLabel' | 'rule'>, raw: string): { ok: true; value: string } | { ok: false; message: string } {
  const value = normalizeIdentifier(raw ?? '');
  const { rule } = t;
  const name = t.identifierLabel;
  if (!value) return { ok: false, message: `Enter the ${name}.` };
  if (!CHARSET[rule.charset].test(value)) {
    const what = rule.charset === 'digits' ? 'digits only' : rule.charset === 'vin' ? 'letters and numbers only (no I, O or Q)' : 'letters and numbers only';
    return { ok: false, message: `The ${name} has ${what}.` };
  }
  if (value.length < rule.minLength || value.length > rule.maxLength) {
    const len = rule.minLength === rule.maxLength ? `${rule.minLength}` : `${rule.minLength} to ${rule.maxLength}`;
    return { ok: false, message: `The ${name} is ${len} characters long. This one has ${value.length}.` };
  }
  if (rule.checksum === 'luhn' && !luhnValid(value)) return { ok: false, message: `This is not a valid ${name}. Check each digit again.` };
  if (rule.checksum === 'vin' && !vinCheckValid(value)) return { ok: false, message: `This is not a valid ${name}. Check each character again.` };
  if (rule.pattern) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(rule.pattern);
    } catch {}
    if (re && !re.test(value)) return { ok: false, message: `This does not look like a ${name}. Check it again.` };
  }
  return { ok: true, value };
}

/** Shows most of an identifier but not all of it, for people who are not its owner or the police. */
export const maskIdentifier = (v: string) => (v.length <= 6 ? v : `${'•'.repeat(Math.max(0, v.length - 4))}${v.slice(-4)}`);

/** Agencies that receive stolen-item reports and buyer-check matches. */
export const STOLEN_AGENCY_KINDS = ['police'];

// ---------------------------------------------------------------- stolen case

export type StolenState = 'reported' | 'investigating' | 'located' | 'recovered' | 'returned' | 'closed' | 'withdrawn';
export type StolenEvent = 'investigate' | 'locate' | 'recover' | 'return_to_owner' | 'close' | 'withdraw';

/** A stolen item from report to recovery. The police move it; the owner can withdraw it (they got it back). */
export const stolenMachine = defineMachine<StolenState, StolenEvent, 'agency_admin' | 'owner'>({
  name: 'stolen item',
  initial: 'reported',
  terminal: ['returned', 'closed', 'withdrawn'],
  transitions: [
    { event: 'investigate', from: ['reported'], to: 'investigating', actors: ['agency_admin'] },
    { event: 'locate', from: ['reported', 'investigating'], to: 'located', actors: ['agency_admin'] },
    { event: 'recover', from: ['investigating', 'located'], to: 'recovered', actors: ['agency_admin'] },
    { event: 'return_to_owner', from: ['recovered'], to: 'returned', actors: ['agency_admin'] },
    { event: 'close', from: ['reported', 'investigating', 'located'], to: 'closed', actors: ['agency_admin'] },
    { event: 'withdraw', from: ['reported', 'investigating', 'located'], to: 'withdrawn', actors: ['owner'] },
  ],
});

/** Still wanted: a buyer check on it comes back "reported stolen". */
export const STOLEN_OPEN: StolenState[] = ['reported', 'investigating', 'located'];

export const stolenStateLabel: Record<StolenState, string> = {
  reported: 'Reported',
  investigating: 'Investigating',
  located: 'Located',
  recovered: 'Recovered',
  returned: 'Returned to owner',
  closed: 'Closed, not recovered',
  withdrawn: 'Withdrawn by owner',
};

/** What the owner sees at each state: a chip and the recovery steps. */
export function stolenStatus(state: StolenState, agency: string): { chip: string; tone: 'info' | 'warning' | 'success' | 'neutral'; line: string } {
  switch (state) {
    case 'reported':
      return { chip: 'Reported', tone: 'warning', line: `Sent to ${agency}. Anyone who checks it before buying is told it is stolen.` };
    case 'investigating':
      return { chip: 'Investigating', tone: 'info', line: `${agency} is looking for it.` };
    case 'located':
      return { chip: 'Located', tone: 'info', line: `${agency} knows where it is and is working to recover it.` };
    case 'recovered':
      return { chip: 'Recovered', tone: 'success', line: `${agency} has your item. They will contact you to return it.` };
    case 'returned':
      return { chip: 'Returned', tone: 'success', line: 'You have your item back.' };
    case 'closed':
      return { chip: 'Closed', tone: 'neutral', line: `${agency} closed the case without recovering it. It stays on the stolen list.` };
    case 'withdrawn':
      return { chip: 'Withdrawn', tone: 'neutral', line: 'You withdrew this report.' };
  }
}

export const STOLEN_STEPS: { key: StolenState; label: string }[] = [
  { key: 'reported', label: 'Reported' },
  { key: 'investigating', label: 'Police investigating' },
  { key: 'located', label: 'Item located' },
  { key: 'recovered', label: 'Recovered' },
  { key: 'returned', label: 'Returned to you' },
];

/** What the buyer was doing when they checked. */
export const CHECK_CONTEXTS = [
  { code: 'buying', label: 'Buying it' },
  { code: 'repairing', label: 'Repairing it' },
  { code: 'found', label: 'I found it' },
  { code: 'other', label: 'Other' },
] as const;
export type CheckContext = (typeof CHECK_CONTEXTS)[number]['code'];

/** Buyer checks per person per hour, so the registry cannot be scraped. */
export const CHECKS_PER_HOUR = 30;
