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
} as const;

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
} as const;

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

export type DonationLeg = { to: 'officer'; id: string; kobo: number } | { to: 'station'; id: string; kobo: number } | { to: 'agency'; id: string; kobo: number };

/**
 * Who gets what. A gift to a named officer goes to that officer; a station gift is split by the agency's
 * shares (the officer part equally between the station's officers); an agency gift goes to the agency.
 * Whole kobo; any remainder goes to the station (or the agency when there is no station part).
 */
export function splitDonation(
  amountKobo: number,
  target: { type: 'agency' | 'station' | 'officer'; id: string; agencyId: string; stationId?: string },
  shares: DonationShares,
  stationOfficers: string[],
): DonationLeg[] {
  if (target.type === 'officer') return [{ to: 'officer', id: target.id, kobo: amountKobo }];
  if (target.type === 'agency') return [{ to: 'agency', id: target.agencyId, kobo: amountKobo }];
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
