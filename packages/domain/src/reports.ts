// Non-emergency reporting: tips (Rewards doc) and public issues (Public Issues doc §1).
import { defineMachine } from './machine';

export interface TipCategory {
  code: string;
  label: string;
  /** Agency kinds that receive it, in order; the first onboarded one is used. */
  agencyKinds: string[];
  /** What the tipper is told, even before the agency joins. */
  agencyLabel: string;
  bounty: boolean;
  /** Emergency path when someone may be in danger (Rewards doc). */
  emergencyHint?: string;
  anonymousDefault?: boolean;
}

export const tipCategories: TipCategory[] = [
  { code: 'fake_drugs', label: 'Fake drugs or food', agencyKinds: ['nafdac'], agencyLabel: 'NAFDAC', bounty: true },
  { code: 'drugs', label: 'Drugs', agencyKinds: ['ndlea'], agencyLabel: 'NDLEA', bounty: true },
  { code: 'human_trafficking', label: 'Human trafficking', agencyKinds: ['naptip'], agencyLabel: 'NAPTIP', bounty: true, anonymousDefault: true },
  { code: 'fake_products', label: 'Fake products', agencyKinds: ['son', 'fccpc', 'nafdac'], agencyLabel: 'SON, NAFDAC', bounty: true },
  { code: 'environmental', label: 'Environmental hazard', agencyKinds: ['nesrea'], agencyLabel: 'NESREA', bounty: true },
  { code: 'virus_outbreak', label: 'Virus outbreak', agencyKinds: ['health'], agencyLabel: 'Health agency', bounty: false },
  { code: 'road_accident', label: 'Road accident', agencyKinds: ['frsc'], agencyLabel: 'FRSC', bounty: false, emergencyHint: 'If anyone is hurt, use SOS so help is sent now.' },
  { code: 'illegal_mining', label: 'Illegal mining', agencyKinds: ['nscdc', 'police'], agencyLabel: 'NSCDC', bounty: true },
  { code: 'cult_activity', label: 'Cult activity', agencyKinds: ['police'], agencyLabel: 'Police', bounty: true },
  { code: 'fraud', label: 'Fraud or corruption', agencyKinds: ['efcc', 'icpc'], agencyLabel: 'EFCC, ICPC', bounty: true },
  { code: 'smuggling', label: 'Smuggling', agencyKinds: ['customs'], agencyLabel: 'Customs', bounty: true },
  { code: 'immigration', label: 'Immigration offence', agencyKinds: ['immigration'], agencyLabel: 'Immigration', bounty: true },
  { code: 'other', label: 'Something else', agencyKinds: [], agencyLabel: 'We will route it', bounty: false },
];
export const tipCategory = (code: string) => tipCategories.find((c) => c.code === code);

/** Board "Agency bounties": the result that makes a tip count as verified for a bounty. */
export const BOUNTY_VERIFIED_WHEN: Record<string, string> = {
  human_trafficking: 'Victim rescued or case opened',
  drugs: 'Seizure or arrest',
  illegal_mining: 'Site shut and equipment seized',
  cult_activity: 'Arrest or case opened',
  fake_drugs: 'Products seized or recalled',
  fake_products: 'Products seized',
  environmental: 'Polluter stopped or fined',
  fraud: 'Case opened or money recovered',
  smuggling: 'Goods seized',
  immigration: 'Arrest or case opened',
};

/** Agencies top up their bounty pool in advance (Rewards doc), so a bounty is never promised without money behind it. */
export const POOL_FUND_LIMITS = { minKobo: 1_000_000, maxKobo: 5_000_000_000 } as const; // ₦10,000 to ₦50,000,000 per payment

/** States doc: "Emergency words found: This sounds urgent. Use SOS so help is sent now." */
const URGENT = /\b(now|right now|bleeding|dying|dead|gun|shoot|shooting|kidnap|kidnapped|fire|burning|attack|attacking|help me|trapped|stabbed)\b/i;
export const soundsUrgent = (text: string) => URGENT.test(text);

export interface IssueCategory {
  code: string;
  label: string;
  agencyKinds: string[];
  agencyLabel: string;
  icon: string;
  subtypes: string[];
  /** One chance vehicles are treated as urgent and can open an emergency. */
  urgent?: boolean;
}

export const issueCategories: IssueCategory[] = [
  { code: 'road', label: 'Bad road or pothole', agencyKinds: ['roads'], agencyLabel: 'Roads agency', icon: 'road', subtypes: ['Pothole', 'Collapsed road', 'Flooded', 'Broken bridge', 'Open drain'] },
  { code: 'highway_hazard', label: 'Highway hazard', agencyKinds: ['frsc'], agencyLabel: 'FRSC', icon: 'riot', subtypes: ['Debris', 'Broken barrier', 'Flooding', 'Missing sign'] },
  { code: 'street_light', label: 'Street light fault', agencyKinds: ['lighting'], agencyLabel: 'Lighting agency', icon: 'tip', subtypes: ['Not working', 'Flickering', 'On in daytime', 'Damaged pole'] },
  { code: 'traffic_light', label: 'Traffic light fault', agencyKinds: ['traffic'], agencyLabel: 'Traffic agency', icon: 'traffic', subtypes: ['Not working', 'Stuck on one colour', 'Damaged'] },
  { code: 'camera_fault', label: 'Camera fault', agencyKinds: ['platform'], agencyLabel: 'Agency in charge', icon: 'camera', subtypes: ['Not working', 'Damaged', 'Moved or covered'] },
  { code: 'one_chance', label: 'One chance vehicle', agencyKinds: ['police', 'frsc'], agencyLabel: 'Police and FRSC', icon: 'accident', subtypes: ['Seen picking passengers', 'Same vehicle again', 'Plate seen'], urgent: true },
  { code: 'building', label: 'Dilapidated building', agencyKinds: ['building'], agencyLabel: 'Building control', icon: 'home', subtypes: ['Cracks', 'Leaning', 'Partly collapsed', 'Abandoned'] },
  { code: 'waste', label: 'Waste or pollution', agencyKinds: ['nesrea', 'epa'], agencyLabel: 'NESREA or State EPA', icon: 'environment', subtypes: ['Illegal dumping', 'Blocked drain', 'Burning waste', 'Spill'] },
];
export const issueCategory = (code: string) => issueCategories.find((c) => c.code === code);

/** Reports of the same issue within this distance merge into one case (Public Issues doc §2). */
export const ISSUE_MERGE_RADIUS_M = 100;
/** "Fixed" is confirmed by this many reporters, or by silence for FIX_SILENCE_DAYS. */
export const FIX_CONFIRMATIONS = 2;
export const FIX_SILENCE_DAYS = 7;

// B3 — public issue case.
export const issueMachine = defineMachine<
  'open' | 'assigned' | 'in_progress' | 'awaiting_check' | 'fixed' | 'reopened',
  'assign' | 'start' | 'mark_fixed' | 'confirm_fixed' | 'not_fixed',
  'agency_admin' | 'citizen' | 'system'
>({
  name: 'public issue',
  initial: 'open',
  terminal: ['fixed'],
  transitions: [
    { event: 'assign', from: ['open'], to: 'assigned', actors: ['agency_admin', 'system'] },
    { event: 'start', from: ['assigned', 'reopened'], to: 'in_progress', actors: ['agency_admin'] },
    { event: 'mark_fixed', from: ['in_progress', 'assigned'], to: 'awaiting_check', actors: ['agency_admin'] },
    // Reporters confirm (FIX_CONFIRMATIONS "yes"), or silence for FIX_SILENCE_DAYS closes it.
    { event: 'confirm_fixed', from: ['awaiting_check'], to: 'fixed', actors: ['citizen', 'system'] },
    { event: 'not_fixed', from: ['awaiting_check'], to: 'reopened', actors: ['citizen'] },
  ],
});
export type IssueState = 'open' | 'assigned' | 'in_progress' | 'awaiting_check' | 'fixed' | 'reopened';

/** What a reporter sees at each state. */
export function issueStatus(state: IssueState, agency: string): { title: string; line: string; step: number } {
  switch (state) {
    case 'open':
      return { title: 'Sent', line: `Waiting for ${agency} to pick it up.`, step: 0 };
    case 'assigned':
      return { title: `With ${agency}`, line: 'They have taken it on.', step: 1 };
    case 'in_progress':
      return { title: 'Work started', line: `${agency} is fixing it.`, step: 2 };
    case 'awaiting_check':
      return { title: 'Is it fixed?', line: `${agency} says it is fixed. Tell us if it is.`, step: 3 };
    case 'reopened':
      return { title: 'Reopened', line: `Reporters say it is not fixed. ${agency} has been told.`, step: 2 };
    case 'fixed':
      return { title: 'Fixed', line: 'Thank you for reporting it.', step: 4 };
  }
}

/** What a tipper sees at each state (board "Tip detail"). */
export function tipStatus(state: string, agency: string): { title: string; chip: string; tone: 'info' | 'warning' | 'success' | 'neutral' | 'critical' } {
  const map: Record<string, { title: string; chip: string; tone: 'info' | 'warning' | 'success' | 'neutral' | 'critical' }> = {
    sent: { title: 'Received', chip: 'Being routed', tone: 'info' },
    in_queue: { title: `Sent to ${agency}`, chip: `With ${agency}`, tone: 'warning' },
    more_info: { title: `${agency} needs more information`, chip: 'Needs more info', tone: 'warning' },
    claim_review: { title: 'Result recorded', chip: 'Bounty in review', tone: 'info' },
    approved_held: { title: 'Bounty approved', chip: 'Bounty on hold', tone: 'success' },
    available: { title: 'Bounty paid', chip: 'Paid', tone: 'success' },
    declined: { title: 'Did not qualify for a bounty', chip: 'Declined', tone: 'neutral' },
    closed_no_result: { title: 'Closed without a result', chip: 'Closed', tone: 'neutral' },
    found_false: { title: 'Could not be confirmed', chip: 'Not confirmed', tone: 'critical' },
    withdrawn: { title: 'You withdrew this tip', chip: 'Withdrawn', tone: 'neutral' },
  };
  return map[state] ?? { title: state, chip: state, tone: 'neutral' };
}

/**
 * What an agency of this kind handles, from the tip and issue catalogues.
 * Drives its menus: a fire service gets neither Bounties nor Public issues,
 * NAPTIP gets Bounties only, a roads agency gets Public issues only.
 */
export function agencyHandles(kind: string) {
  const tips = tipCategories.filter((c) => c.agencyKinds.includes(kind));
  const issues = issueCategories.filter((c) => c.agencyKinds.includes(kind));
  return {
    tips: tips.length > 0,
    bounties: tips.some((c) => c.bounty),
    issues: issues.length > 0,
    tipCategories: tips.map((c) => c.code),
    bountyCategories: tips.filter((c) => c.bounty).map((c) => c.code),
    issueCategories: issues.map((c) => c.code),
  };
}
export type AgencyHandles = ReturnType<typeof agencyHandles>;
