// Agency onboarding and subscription — UX Gap Analysis §10 (canonical lifecycle, stages 1–11).
// States match the agencies.status check constraint in db/migrations/003_agencies.sql.
import { defineMachine } from './machine';
import { formatNaira, kobo, type Kobo } from './money';

type Sys = 'system';

export const agencyStates = [
  'registering',
  'documents_submitted',
  'in_review',
  'more_info_needed',
  'rejected',
  'approved',
  'fee_pending',
  'setting_up',
  'live',
  'overdue',
  'offboarding',
  'offboarded',
] as const;
export type AgencyState = (typeof agencyStates)[number];

export type AgencyEvent =
  | 'submit'
  | 'start_review'
  | 'ask_more'
  | 'approve'
  | 'reject'
  | 'choose_plan'
  | 'fee_paid'
  | 'go_live'
  | 'invoice_overdue'
  | 'payment_received'
  | 'request_offboard'
  | 'complete_offboard';

/** agency_admin is the contact person; platform_admin covers review and finance. */
export type AgencyActor = 'agency_admin' | 'platform_admin' | Sys;

export const agencyMachine = defineMachine<AgencyState, AgencyEvent, AgencyActor>({
  name: 'agency',
  initial: 'registering',
  terminal: ['rejected', 'offboarded'],
  transitions: [
    // 2 → 3. "Ask for more" loops back to the documents step with the comment shown.
    { event: 'submit', from: ['registering', 'more_info_needed'], to: 'documents_submitted', actors: ['agency_admin'] },
    { event: 'start_review', from: ['documents_submitted'], to: 'in_review', actors: ['platform_admin'] },
    { event: 'ask_more', from: ['in_review'], to: 'more_info_needed', actors: ['platform_admin'] },
    { event: 'approve', from: ['in_review'], to: 'approved', actors: ['platform_admin'] },
    // Reject is final, with an appeal contact.
    { event: 'reject', from: ['in_review'], to: 'rejected', actors: ['platform_admin'] },
    // 4. Choosing again before paying replaces the quote.
    { event: 'choose_plan', from: ['approved', 'fee_pending'], to: 'fee_pending', actors: ['agency_admin'] },
    // 5. "Webhook or finance confirmation only."
    { event: 'fee_paid', from: ['fee_pending'], to: 'setting_up', actors: ['system'] },
    // 7. Gate: the setup checklist's required steps are done.
    { event: 'go_live', from: ['setting_up'], to: 'live', actors: ['agency_admin'] },
    // 9. Live dispatch never stops; "restored the same day on payment".
    { event: 'invoice_overdue', from: ['live'], to: 'overdue', actors: ['system'] },
    { event: 'payment_received', from: ['overdue'], to: 'live', actors: ['system'] },
    // 11.
    { event: 'request_offboard', from: ['setting_up', 'live', 'overdue'], to: 'offboarding', actors: ['agency_admin'] },
    { event: 'complete_offboard', from: ['offboarding'], to: 'offboarded', actors: ['platform_admin'] },
  ],
});

/**
 * What an agency can do in each state. Dispatch is true from go-live until
 * offboarding completes, whatever the billing state ("live dispatch never stops").
 */
export const agencyFeatures: Record<AgencyState, { editApplication: boolean; dispatch: boolean; addStations: boolean; addInventory: boolean; changePlan: boolean }> = {
  registering: { editApplication: true, dispatch: false, addStations: false, addInventory: false, changePlan: false },
  documents_submitted: { editApplication: false, dispatch: false, addStations: false, addInventory: false, changePlan: false },
  in_review: { editApplication: false, dispatch: false, addStations: false, addInventory: false, changePlan: false },
  more_info_needed: { editApplication: true, dispatch: false, addStations: false, addInventory: false, changePlan: false },
  rejected: { editApplication: false, dispatch: false, addStations: false, addInventory: false, changePlan: false },
  approved: { editApplication: false, dispatch: false, addStations: false, addInventory: false, changePlan: false },
  fee_pending: { editApplication: false, dispatch: false, addStations: false, addInventory: false, changePlan: false },
  setting_up: { editApplication: false, dispatch: false, addStations: true, addInventory: true, changePlan: true },
  live: { editApplication: false, dispatch: true, addStations: true, addInventory: true, changePlan: true },
  overdue: { editApplication: false, dispatch: true, addStations: false, addInventory: false, changePlan: true },
  offboarding: { editApplication: false, dispatch: true, addStations: false, addInventory: false, changePlan: false },
  offboarded: { editApplication: false, dispatch: false, addStations: false, addInventory: false, changePlan: false },
};

/** Agency states whose stations receive live reports. Routing reads this list. */
export const dispatchingAgencyStates = agencyStates.filter((s) => agencyFeatures[s].dispatch);

// ---------------------------------------------------------------- invoices

export type AgencyInvoiceState = 'draft' | 'issued' | 'paid' | 'overdue' | 'waived' | 'credited';
export type AgencyInvoiceEvent = 'issue' | 'mark_overdue' | 'payment_confirmed' | 'transfer_marked' | 'waive' | 'credit';

export const agencyInvoiceMachine = defineMachine<AgencyInvoiceState, AgencyInvoiceEvent, 'platform_admin' | Sys>({
  name: 'agency_invoice',
  initial: 'draft',
  terminal: ['paid', 'waived', 'credited'],
  transitions: [
    { event: 'issue', from: ['draft'], to: 'issued', actors: ['system'] },
    { event: 'mark_overdue', from: ['issued'], to: 'overdue', actors: ['system'] },
    // Paystack webhook.
    { event: 'payment_confirmed', from: ['issued', 'overdue'], to: 'paid', actors: ['system'] },
    // Finance marks an unmatched bank transfer as received.
    { event: 'transfer_marked', from: ['issued', 'overdue'], to: 'paid', actors: ['platform_admin'] },
    // Reason always; a second approver above the threshold.
    { event: 'waive', from: ['issued', 'overdue'], to: 'waived', actors: ['platform_admin'] },
    { event: 'credit', from: ['issued', 'overdue'], to: 'credited', actors: ['platform_admin'] },
  ],
});

export const openInvoiceStates: readonly AgencyInvoiceState[] = ['issued', 'overdue'];

// ---------------------------------------------------------------- registration

/** The agencies in Rewards, Wallet and Billing, plus "other". `kind` matches incident_types.default_units. */
export const agencyDirectory = [
  { kind: 'police', name: 'Nigeria Police Force' },
  { kind: 'efcc', name: 'EFCC' },
  { kind: 'ndlea', name: 'NDLEA' },
  { kind: 'icpc', name: 'ICPC' },
  { kind: 'naptip', name: 'NAPTIP' },
  { kind: 'nafdac', name: 'NAFDAC' },
  { kind: 'son', name: 'SON' },
  { kind: 'fccpc', name: 'FCCPC' },
  { kind: 'frsc', name: 'FRSC' },
  { kind: 'customs', name: 'Nigeria Customs Service' },
  { kind: 'immigration', name: 'Nigeria Immigration Service' },
  { kind: 'nscdc', name: 'NSCDC' },
  { kind: 'fire', name: 'Federal Fire Service' },
  { kind: 'corrections', name: 'Nigeria Correctional Service' },
  { kind: 'dia', name: 'Defence Intelligence Agency' },
  { kind: 'nesrea', name: 'NESREA' },
  { kind: 'other', name: 'Other' },
] as const;
export type AgencyKind = (typeof agencyDirectory)[number]['kind'];

export type AgencyDocumentKind = 'establishment_proof' | 'authorisation_letter' | 'head_id' | 'signatory_letter' | 'registration_certificate';

export const agencyDocumentLabels: Record<AgencyDocumentKind, string> = {
  establishment_proof: 'Proof of establishment',
  authorisation_letter: 'Authorisation letter or MOU',
  head_id: "Head's ID",
  signatory_letter: 'Signatory letter',
  registration_certificate: 'Registration certificate',
};

/** "Required list per agency type." Bodies not on the federal list also send their registration. */
export function requiredAgencyDocuments(kind: AgencyKind): AgencyDocumentKind[] {
  const base: AgencyDocumentKind[] = ['establishment_proof', 'authorisation_letter', 'head_id', 'signatory_letter'];
  return kind === 'other' ? [...base, 'registration_certificate'] : base;
}

/** "Email on a government or agency domain flagged as stronger evidence." */
export function emailEvidence(email: string): 'government_domain' | 'other_domain' {
  const domain = email.trim().toLowerCase().split('@')[1] ?? '';
  return /(^|\.)(gov|mil)\.ng$/.test(domain) ? 'government_domain' : 'other_domain';
}

/** Account names on a payout account must match the signatory (stage 6, step 4). */
export function namesMatch(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
  return norm(a) === norm(b);
}

// ---------------------------------------------------------------- pricing

export interface AgencyPrice {
  code: string;
  label: string;
  /** Monthly for plans and add-ons, per item for inventory, per message for usage, one-off for onboarding. */
  amountKobo: number;
  /** Units included per quantity, e.g. messaging credits. */
  includes?: { stations?: number; messages?: number };
}

export interface InvoiceLine {
  code: string;
  label: string;
  quantity: number;
  unitKobo: number;
  amountKobo: number;
}

export interface InvoiceTotals {
  lines: InvoiceLine[];
  subtotalKobo: number;
  vatKobo: number;
  totalKobo: number;
}

export interface BillingInput {
  prices: Record<string, AgencyPrice>;
  basePlan: string;
  /** Selected add-ons: code → quantity. */
  addons: Record<string, number>;
  stationCount?: number;
  /** Inventory fee code → quantity. */
  inventory?: Record<string, number>;
  /** Usage fee code (e.g. messaging_sms) → units used in the period. */
  usage?: Record<string, number>;
  vatRate: number;
}

const line = (p: AgencyPrice, quantity: number): InvoiceLine => ({
  code: p.code,
  label: p.label,
  quantity,
  unitKobo: p.amountKobo,
  amountKobo: kobo(p.amountKobo * quantity),
});

function price(prices: Record<string, AgencyPrice>, code: string): AgencyPrice {
  const p = prices[code];
  if (!p) throw new Error(`No price for ${code}`);
  return p;
}

export function totals(lines: InvoiceLine[], vatRate: number): InvoiceTotals {
  const subtotalKobo = lines.reduce((s, l) => s + l.amountKobo, 0);
  const vatKobo = Math.round(subtotalKobo * vatRate);
  return { lines, subtotalKobo, vatKobo, totalKobo: subtotalKobo + vatKobo };
}

/** Recurring lines for one month: base, add-ons, stations beyond the allowance, inventory, messaging beyond credits. */
export function monthlyLines(b: BillingInput): InvoiceLine[] {
  const base = price(b.prices, b.basePlan);
  const out: InvoiceLine[] = [line(base, 1)];
  let stationAllowance = base.includes?.stations ?? 0;
  let messageCredits = 0;
  for (const [code, qty] of Object.entries(b.addons)) {
    if (qty <= 0) continue;
    const p = price(b.prices, code);
    out.push(line(p, qty));
    stationAllowance += (p.includes?.stations ?? 0) * qty;
    messageCredits += (p.includes?.messages ?? 0) * qty;
  }
  const extraStations = Math.max(0, (b.stationCount ?? 0) - stationAllowance);
  if (extraStations > 0) {
    const p = price(b.prices, 'station_overage');
    out.push(line(p, extraStations));
  }
  for (const [code, qty] of Object.entries(b.inventory ?? {})) if (qty > 0) out.push(line(price(b.prices, code), qty));
  for (const [code, units] of Object.entries(b.usage ?? {})) {
    const billable = Math.max(0, units - messageCredits);
    messageCredits = Math.max(0, messageCredits - units);
    if (billable > 0) out.push(line(price(b.prices, code), billable));
  }
  return out;
}

/** Stage 4 summary: onboarding fee + first period, VAT. */
export function onboardingQuote(b: BillingInput, onboardingCode = 'onboarding'): InvoiceTotals & { monthlyKobo: number } {
  const monthly = monthlyLines({ ...b, stationCount: 0, inventory: {}, usage: {} });
  const t = totals([line(price(b.prices, onboardingCode), 1), ...monthly], b.vatRate);
  return { ...t, monthlyKobo: totals(monthly, b.vatRate).totalKobo };
}

const DAY = 86_400_000;
const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/** Days left in [start, end) from `on`, inclusive of `on`. */
export function daysLeft(periodStart: Date, periodEnd: Date, on: Date): { left: number; total: number } {
  const total = Math.round((utcDay(periodEnd) - utcDay(periodStart)) / DAY);
  const left = Math.min(total, Math.max(0, Math.round((utcDay(periodEnd) - utcDay(on)) / DAY)));
  return { left, total };
}

/** Upgrade now, prorated to the rest of the period (stage 10). */
export function prorate(monthlyDeltaKobo: number, periodStart: Date, periodEnd: Date, on: Date): Kobo {
  const { left, total } = daysLeft(periodStart, periodEnd, on);
  if (total <= 0 || monthlyDeltaKobo <= 0) return kobo(0);
  return kobo(Math.round((monthlyDeltaKobo * left) / total));
}

/** Next period end: same day next month, clamped to the month's last day. */
export function addMonth(d: Date): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last)));
}

export type PlanChange = { code: string; from: number; to: number; when: 'now' | 'period_end' };

/** Increases apply now (prorated); decreases apply at period end. */
export function classifyPlanChange(current: Record<string, number>, next: Record<string, number>): PlanChange[] {
  const codes = new Set([...Object.keys(current), ...Object.keys(next)]);
  const out: PlanChange[] = [];
  for (const code of codes) {
    const from = current[code] ?? 0;
    const to = next[code] ?? 0;
    if (from !== to) out.push({ code, from, to, when: to > from ? 'now' : 'period_end' });
  }
  return out.sort((a, b) => a.code.localeCompare(b.code));
}

// ---------------------------------------------------------------- dual control

export type DualControl =
  | { ok: true; complete: boolean; approvals: string[] }
  | { ok: false; code: 'same_approver'; message: string };

/**
 * Payouts and waivers above the threshold need two different people (Security doc,
 * Payout detail: "second approval"). At or below it, one approval completes.
 */
export function approve(input: { amountKobo: number; thresholdKobo: number; approvals: readonly string[]; approverId: string }): DualControl {
  if (input.approvals.includes(input.approverId)) {
    return { ok: false, code: 'same_approver', message: 'A second approver must be a different person.' };
  }
  const approvals = [...input.approvals, input.approverId];
  const needed = input.amountKobo > input.thresholdKobo ? 2 : 1;
  return { ok: true, complete: approvals.length >= needed, approvals };
}

// ---------------------------------------------------------------- copy

/** Final copy from States and Notifications and the §10 lifecycle table. */
export const agencyCopy = {
  overdueBanner: 'New stations and equipment are on hold until you pay.',
  overdueLine: (dueOn: string) => `Pay by ${dueOn} to keep adding stations.`,
  paymentFailed: (amountKobo: number) => `We could not take ${formatNaira(amountKobo)}. Adding stations and items is paused.`,
  approveConfirm: (name: string) => `Approve ${name}? It can start adding stations.`,
  bankNotVerified: 'Verify the account before the next payout.',
  poolLow: (poolKobo: number, pendingKobo: number) => `Pool has ${formatNaira(poolKobo)}, below pending claims of ${formatNaira(pendingKobo)}.`,
  duplicateStation: 'A station already uses this building.',
  postcodeNotFound: 'We could not find that building. Check the postcode or pick it from the list.',
  live: 'You are live',
  waitingForPayment: 'Waiting for payment',
  rejectedAppeal: 'To appeal, email agencies@erp.ng with your application number.',
} as const;

/** The timeline on the status page: Submitted → In review → Decision. */
export function reviewStep(s: AgencyState): 'draft' | 'submitted' | 'in_review' | 'decision' {
  if (s === 'registering' || s === 'more_info_needed') return 'draft';
  if (s === 'documents_submitted') return 'submitted';
  if (s === 'in_review') return 'in_review';
  return 'decision';
}
