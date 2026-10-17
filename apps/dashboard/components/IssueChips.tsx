// Chips for public issue cases and tips — colour + word, never colour alone (Design Brief).

const ISSUE: Record<string, [string, string]> = {
  open: ['warning', 'Open'],
  assigned: ['info', 'Taken on'],
  in_progress: ['info', 'Work started'],
  awaiting_check: ['info', 'Waiting for reporters'],
  reopened: ['critical', 'Reopened'],
  fixed: ['success', 'Fixed'],
};
const SEVERITY: Record<string, [string, string]> = {
  small: ['neutral', 'Small'],
  dangerous: ['warning', 'Dangerous'],
  blocking: ['critical', 'Blocking'],
};
const TIP: Record<string, [string, string]> = {
  sent: ['info', 'Being routed'],
  in_queue: ['warning', 'New'],
  more_info: ['warning', 'Waiting for tipper'],
  claim_review: ['info', 'Claim to review'],
  approved_held: ['success', 'Approved, on hold'],
  available: ['success', 'Paid'],
  declined: ['neutral', 'Declined'],
  closed_no_result: ['neutral', 'Closed'],
  found_false: ['critical', 'Marked false'],
  withdrawn: ['neutral', 'Withdrawn'],
};

const chip = (map: Record<string, [string, string]>, key: string) => {
  const [tone, label] = map[key] ?? ['neutral', key];
  return <span className={`chip ${tone}`}>{label}</span>;
};

export const IssueStateChip = ({ state }: { state: string }) => chip(ISSUE, state);
export const SeverityChip = ({ severity }: { severity: string }) => chip(SEVERITY, severity);
export const TipStateChip = ({ state }: { state: string }) => chip(TIP, state);
export const severityLabel = (s: string) => SEVERITY[s]?.[1] ?? s;

/** A fix date in the past while the agency still has the work. */
export const isOverdue = (r: { target_on?: string | null; targetOn?: string | null; state: string }, today: string) => {
  const t = r.target_on ?? r.targetOn;
  return !!t && t < today && ['assigned', 'in_progress', 'reopened'].includes(r.state);
};

export const OUTCOMES: Array<[string, string]> = [
  ['arrest', 'Arrest'],
  ['seizure', 'Seizure'],
  ['rescue', 'Rescue'],
  ['case_opened', 'Case opened'],
];
export const outcomeLabel = (o: string | null) => (o ? (OUTCOMES.find(([k]) => k === o)?.[1] ?? o) : null);
