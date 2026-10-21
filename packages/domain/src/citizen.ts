// Citizen profile and home: fines (B8), donations (B9), household (B4 step 8), devices and repairs (B5, B6).
import { formatNaira } from './money';

// ---------------------------------------------------------------- fines (B8)

/** "Warnings first, then a fine by configured policy" (SRS TRUST). */
export const FINE_POLICY = {
  /** False alarms inside this window count towards a fine. */
  windowDays: 180,
  /** This many warnings come before the first fine. */
  warningsBeforeFine: 1,
  amountKobo: 500_000, // ₦5,000
  appealDays: 14,
  appealMinChars: 20,
  trustWarning: -5,
  trustFine: -10,
  /** Decided 2026-10-21: the station head confirms or overturns a false-alarm closure first; silence for this long means it goes ahead. */
  reviewHours: 48,
} as const;

/** Decided 2026-10-21: who gets a paid fine. The pool is the rewards pool that pays officers for rated responses. */
export const FINE_SHARES = { agencyPct: 40, poolPct: 30, platformPct: 30 } as const;

/** Splits a paid fine in whole kobo; the remainder goes to the platform. No agency (unknown station): its part goes to the pool. */
export function splitFine(amountKobo: number, hasAgency: boolean): { agency: number; pool: number; platform: number } {
  const agency = hasAgency ? Math.floor((amountKobo * FINE_SHARES.agencyPct) / 100) : 0;
  const pool = Math.floor((amountKobo * (FINE_SHARES.poolPct + (hasAgency ? 0 : FINE_SHARES.agencyPct))) / 100);
  return { agency, pool, platform: amountKobo - agency - pool };
}

// ---------------------------------------------------------------- statements (B7)

export const STATEMENT_LANGUAGES = [
  { code: 'auto', label: 'Auto' },
  { code: 'yo', label: 'Yoruba' },
  { code: 'ha', label: 'Hausa' },
  { code: 'ig', label: 'Igbo' },
  { code: 'pcm', label: 'Pidgin' },
  { code: 'en', label: 'English' },
] as const;
export const languageName = (code: string) => STATEMENT_LANGUAGES.find((l) => l.code === code)?.label ?? code;
export const STATEMENT_RULES = { minChars: 20, maxChars: 8000, shareDays: 7, lowConfidence: 0.75 } as const;

export type FalseAlarmOutcome = { kind: 'warning'; trustDelta: number } | { kind: 'fine'; trustDelta: number; amountKobo: number };

/** What a false alarm costs, given how many the person had inside the window. Joiners are never fined. */
export function falseAlarmOutcome(priorInWindow: number): FalseAlarmOutcome {
  if (priorInWindow < FINE_POLICY.warningsBeforeFine) return { kind: 'warning', trustDelta: FINE_POLICY.trustWarning };
  return { kind: 'fine', trustDelta: FINE_POLICY.trustFine, amountKobo: FINE_POLICY.amountKobo };
}

export function checkAppeal(reason: string): string | null {
  return reason.trim().length < FINE_POLICY.appealMinChars ? `Tell us why in at least ${FINE_POLICY.appealMinChars} characters.` : null;
}

export function trustBand(score: number): 'high' | 'normal' | 'low' {
  return score >= 80 ? 'high' : score < 50 ? 'low' : 'normal';
}

// ---------------------------------------------------------------- donations (B9)

export const DONATION_RULES = {
  presetsKobo: [50_000, 100_000, 200_000], // ₦500, ₦1,000, ₦2,000
  minKobo: 10_000, // ₦100
  maxKobo: 50_000_000, // ₦500,000
  /** Officers' shares are held like rewards before they can be withdrawn. */
  holdDays: 7,
  /** Decided 2026-10-21: the platform keeps 30% of each donation; the rest goes to who was chosen. */
  platformFeePct: 30,
} as const;

/** The platform's share of a donation, in whole kobo (rounded down, so the receivers never lose a kobo). */
export const donationFee = (amountKobo: number) => Math.floor((amountKobo * DONATION_RULES.platformFeePct) / 100);

export function checkDonation(amountKobo: number): string | null {
  if (!Number.isInteger(amountKobo) || amountKobo < DONATION_RULES.minKobo) return `Give at least ${formatNaira(DONATION_RULES.minKobo)}.`;
  if (amountKobo > DONATION_RULES.maxKobo) return `Give up to ${formatNaira(DONATION_RULES.maxKobo)} at a time.`;
  return null;
}

export interface DonationShares {
  officerPct: number;
  stationPct: number;
  agencyPct: number;
}
export const DEFAULT_DONATION_SHARES: DonationShares = { officerPct: 50, stationPct: 30, agencyPct: 20 };

export type DonationLeg = { to: 'officer' | 'station' | 'agency'; id: string; kobo: number } | { to: 'platform_fees'; id: null; kobo: number };

/**
 * Who gets what. The platform keeps its fee first. A gift to a named officer goes to that officer; a
 * station gift is split by the agency's shares (the officer part equally between the station's officers);
 * an agency gift goes to the agency. Whole kobo; any remainder goes to the station.
 */
export function splitDonation(
  amountKobo: number,
  target: { type: 'agency' | 'station' | 'officer'; id: string; agencyId: string; stationId?: string },
  shares: DonationShares,
  stationOfficers: string[],
): DonationLeg[] {
  const fee = donationFee(amountKobo);
  const feeLeg: DonationLeg[] = fee ? [{ to: 'platform_fees', id: null, kobo: fee }] : [];
  const net = amountKobo - fee;
  if (target.type === 'officer') return [{ to: 'officer', id: target.id, kobo: net }, ...feeLeg];
  if (target.type === 'agency') return [{ to: 'agency', id: target.agencyId, kobo: net }, ...feeLeg];
  return [...splitStation(net, target, shares, stationOfficers), ...feeLeg];
}

function splitStation(amountKobo: number, target: { id: string; agencyId: string }, shares: DonationShares, stationOfficers: string[]): DonationLeg[] {
  const officerPart = stationOfficers.length ? Math.floor((amountKobo * shares.officerPct) / 100) : 0;
  const each = stationOfficers.length ? Math.floor(officerPart / stationOfficers.length) : 0;
  const agencyPart = Math.floor((amountKobo * shares.agencyPct) / 100);
  const legs: DonationLeg[] = stationOfficers.map((id) => ({ to: 'officer' as const, id, kobo: each }));
  const stationPart = amountKobo - each * stationOfficers.length - agencyPart;
  legs.push({ to: 'station', id: target.id, kobo: stationPart });
  if (agencyPart) legs.push({ to: 'agency', id: target.agencyId, kobo: agencyPart });
  return legs.filter((l) => l.kobo > 0);
}

// ---------------------------------------------------------------- household and devices (B4, B6)

export const HOUSEHOLD_RULES = { maxMembers: 6 } as const;

export const DEVICE_PROBLEMS = [
  { code: 'offline', label: 'Offline', for: ['camera', 'street_light'] },
  { code: 'blurry', label: 'Blurry or dark', for: ['camera'] },
  { code: 'light_out', label: 'Light not working', for: ['street_light'] },
  { code: 'flickering', label: 'Flickering', for: ['street_light'] },
  { code: 'damaged', label: 'Damaged or moved', for: ['camera', 'street_light'] },
  { code: 'power', label: 'Power problem', for: ['camera', 'street_light'] },
] as const;
export type DeviceProblem = (typeof DEVICE_PROBLEMS)[number]['code'];
export const problemLabel = (code: string) => DEVICE_PROBLEMS.find((p) => p.code === code)?.label ?? code;

export const DEVICE_RULES = {
  /** "Light up the street for 1 hour", the owner's boost (B6). */
  boostMinutes: 60,
  boostsPerNight: 2,
  recordingDaysOptions: [3, 7, 14, 30],
  lowBatteryPct: 25,
  /** A tamper or damage report is urgent and alerts the station that covers the home. */
  urgentProblems: ['damaged'] as readonly string[],
} as const;

export function checkRepairReport(r: { problem: string; description: string }): { field: 'problem' | 'description'; message: string } | null {
  if (!DEVICE_PROBLEMS.some((p) => p.code === r.problem)) return { field: 'problem', message: 'Choose what is wrong.' };
  if (r.description.trim().split(/\s+/).filter(Boolean).length < 3) return { field: 'description', message: 'Add at least a few words so the team knows what to bring.' };
  return null;
}

/** Repair status page steps (board "Repair status"); derived from the job's timestamps. */
export type RepairStep = 'received' | 'confirmed' | 'booked' | 'fixed' | 'closed';
export function repairStep(j: { faultConfirmedAt?: unknown; bookedAt?: unknown; fixedAt?: unknown; confirmedAt?: unknown; state: string }): RepairStep {
  if (j.confirmedAt) return 'closed';
  if (j.fixedAt) return 'fixed';
  if (j.bookedAt && j.state !== 'unassigned') return 'booked';
  if (j.faultConfirmedAt) return 'confirmed';
  return 'received';
}

// ---------------------------------------------------------------- home plans and billing (B4, board "Payment problem")

/** Days since a monthly charge failed → what still works. Paying at any time restores everything the same day. */
export const DUNNING = {
  retryDays: [1, 3, 5],
  stages: [
    { state: 'grace', fromDay: 1, toDay: 7, title: 'everything keeps working', line: 'We try your card again on days 1, 3 and 5 and remind you.' },
    { state: 'extras_paused', fromDay: 8, toDay: 14, title: 'extras pause', line: 'Live view and clip history pause. Cameras keep recording and the street light stays on.' },
    { state: 'sharing_paused', fromDay: 15, toDay: 30, title: 'shared features pause', line: 'Your cameras stop feeding briefs to responders. Emergency reporting still works.' },
    { state: 'switched_off', fromDay: 31, toDay: null, title: 'devices switched off', line: 'We contact you to arrange a visit. Paying at any time restores everything.' },
  ],
} as const;
export type DunningState = (typeof DUNNING.stages)[number]['state'];

/** Day 1 is the day the charge failed. */
export function dunningStage(daysSinceDue: number): DunningState {
  const d = Math.max(1, daysSinceDue);
  return [...DUNNING.stages].reverse().find((s) => d >= s.fromDay)!.state;
}

/** What is paid today when subscribing: the install fee and the first month. Billing then starts at install. */
export const firstPayment = (plan: { priceKobo: number; installFeeKobo: number }) => plan.installFeeKobo + plan.priceKobo;
