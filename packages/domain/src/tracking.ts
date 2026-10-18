// What the reporter sees in each state — Report Tracking and Data Flow §A3.
// Wording is final copy from the States and Notifications doc where it exists.
import { incidentTimers, type IncidentState, type ReportDeliveryState } from './incident';

export type CitizenAction = 'cancel' | 'add_info' | 'share_contacts' | 'call' | 'message' | 'rate' | 'appeal' | 'send_sms' | 'call_112';

/** The six visible steps of the status timeline component (SRS REP-6). */
export const timelineSteps = ['Received', 'Dispatched', 'Accepted', 'En route', 'On scene', 'Resolved'] as const;

export interface CitizenStatusContext {
  agencyLabel?: string;
  stationName?: string;
  officerName?: string;
  etaMinutes?: number;
  reportCount?: number;
  joined?: boolean;
  transferredTo?: string;
  hasFine?: boolean;
  discreet?: boolean;
}

export interface CitizenStatus {
  title: string;
  line: string;
  /** Index into timelineSteps of the current step; -1 before Received. */
  step: number;
  /** "Who holds it now" — station, then officer. */
  holder?: string;
  actions: CitizenAction[];
  showOfficerCard: boolean;
  showLiveMap: boolean;
  tone: 'neutral' | 'progress' | 'success' | 'warning';
}

const fill = (s: string | undefined, fallback: string) => s ?? fallback;

export function citizenStatus(state: IncidentState, ctx: CitizenStatusContext = {}): CitizenStatus {
  const agency = fill(ctx.agencyLabel, 'team');
  const officer = fill(ctx.officerName, 'An officer');
  const station = fill(ctx.stationName, 'the nearest station');
  const eta = ctx.etaMinutes !== undefined ? `About ${ctx.etaMinutes} min.` : 'Working out the arrival time.';
  const waiting: CitizenAction[] = ['cancel', 'add_info', 'share_contacts'];
  const withOfficer: CitizenAction[] = ['call', 'message', 'add_info', 'cancel'];

  let s: CitizenStatus;
  switch (state) {
    case 'pending_cancel':
      s = { title: `Sending in ${incidentTimers.cancelRingSeconds}`, line: 'Tap Cancel if this was a mistake.', step: -1, actions: ['cancel'], showOfficerCard: false, showLiveMap: false, tone: 'neutral' };
      break;
    case 'received':
      s = { title: 'Report received', line: `Finding the nearest ${agency}.`, step: 0, actions: waiting, showOfficerCard: false, showLiveMap: true, tone: 'progress' };
      break;
    case 'offered':
      s = { title: `Contacting ${station}`, line: 'Waiting for an officer to accept.', step: 1, holder: station, actions: waiting, showOfficerCard: false, showLiveMap: true, tone: 'progress' };
      break;
    case 'escalated':
      s = { title: 'Still looking', line: 'Passing your report to the next team. Stay where you are.', step: 1, holder: station, actions: [...waiting, 'call_112'], showOfficerCard: false, showLiveMap: true, tone: 'warning' };
      break;
    case 'accepted':
      s = { title: 'Help accepted', line: `${officer} from ${station} is getting ready.`, step: 2, holder: officer, actions: withOfficer, showOfficerCard: true, showLiveMap: true, tone: 'progress' };
      break;
    case 'en_route':
      s = { title: 'On the way', line: eta, step: 3, holder: officer, actions: withOfficer, showOfficerCard: true, showLiveMap: true, tone: 'progress' };
      break;
    case 'reassigning':
      s = { title: 'Changing teams', line: `${officer} can't come. We're sending another team.`, step: 1, actions: waiting, showOfficerCard: false, showLiveMap: true, tone: 'warning' };
      break;
    case 'transferred':
      s = { title: `Passed to ${fill(ctx.transferredTo, 'another agency')}`, line: 'They handle this kind of emergency.', step: 1, holder: ctx.transferredTo, actions: waiting, showOfficerCard: false, showLiveMap: true, tone: 'progress' };
      break;
    case 'on_scene':
      s = { title: 'Help has arrived', line: `${officer} is with you.`, step: 4, holder: officer, actions: ['message', 'add_info'], showOfficerCard: true, showLiveMap: false, tone: 'success' };
      break;
    case 'closing':
      s = { title: 'Finishing up', line: 'The team is writing the report.', step: 4, holder: officer, actions: ['message'], showOfficerCard: true, showLiveMap: false, tone: 'success' };
      break;
    case 'resolved':
      s = { title: 'Report closed', line: 'Thank you. Please rate the response.', step: 5, actions: ['rate'], showOfficerCard: true, showLiveMap: false, tone: 'success' };
      break;
    case 'unfounded':
      s = { title: 'Closed', line: 'Officers could not confirm an emergency at this place.', step: 5, actions: ctx.hasFine ? ['appeal'] : [], showOfficerCard: false, showLiveMap: false, tone: 'neutral' };
      break;
    case 'cancelled':
      s = { title: 'You cancelled this report', line: 'No one will be sent.', step: -1, actions: [], showOfficerCard: false, showLiveMap: false, tone: 'neutral' };
      break;
    case 'merged':
      s = { title: 'Already being handled', line: 'Your report joined one that is already open.', step: 1, actions: waiting, showOfficerCard: false, showLiveMap: true, tone: 'progress' };
      break;
  }

  if (ctx.joined && ctx.reportCount && ctx.reportCount > 1 && !['cancelled', 'unfounded'].includes(state)) {
    const others = ctx.reportCount - 1;
    s.line = `You and ${others === 1 ? '1 other person' : `${others} others`} reported this. ${s.line}`;
  }
  if (ctx.discreet) {
    // Discreet mode: neutral words, no names (Design Brief, Emergency UX rules).
    s = { ...s, title: 'Request in progress', line: s.tone === 'success' ? 'Done.' : 'Updating.', holder: undefined, showOfficerCard: false };
  }
  return s;
}

export function deliveryStatus(state: ReportDeliveryState): { title: string; line: string; actions: CitizenAction[] } {
  switch (state) {
    case 'sending':
      return { title: 'Sending', line: 'Hold on.', actions: [] };
    case 'queued_offline':
      return { title: 'No connection', line: "Your report is saved. We'll keep trying, and send it by SMS.", actions: ['send_sms', 'call_112'] };
    case 'sms_sent':
      return { title: 'Sent by SMS', line: "We'll text you updates.", actions: ['call_112'] };
    case 'failed':
      return { title: 'Still trying', line: 'We could not reach the server. Send by SMS or call 112.', actions: ['send_sms', 'call_112'] };
    case 'submitted':
      return { title: 'Report received', line: 'Finding the nearest team.', actions: [] };
  }
}

export type Freshness = { kind: 'live' } | { kind: 'stale'; secondsAgo: number } | { kind: 'reconnecting'; smsUpdates: boolean };

/** The freshness line on Live status (A3). */
export function freshness(lastUpdateAt: Date, now: Date, socketConnected: boolean): Freshness {
  const secondsAgo = Math.max(0, Math.round((now.getTime() - lastUpdateAt.getTime()) / 1000));
  if (!socketConnected) return { kind: 'reconnecting', smsUpdates: secondsAgo >= incidentTimers.smsFallbackAfterSeconds };
  if (secondsAgo >= incidentTimers.staleAfterSeconds) return { kind: 'stale', secondsAgo };
  return { kind: 'live' };
}

/** Rating tags a citizen can add (incidents controller), grouped into the officer's three sub-scores. */
export const RATING_DIMENSIONS = {
  arrival: { label: 'Arrival speed', good: ['fast'], bad: ['slow'] },
  care: { label: 'Care and manner', good: ['polite', 'professional'], bad: ['rude'] },
  communication: { label: 'Communication', good: ['clear'], bad: ['unclear'] },
} as const;
export type RatingDimension = keyof typeof RATING_DIMENSIONS;

/**
 * Board "Officer profile and rating": the overall score is the star average; each sub-score
 * starts from it and moves up to half a star with the share of good versus bad tags.
 */
export function subRatings(ratings: { stars: number; tags: readonly string[] }[]): { overall: number | null; count: number } & Record<RatingDimension, number | null> {
  if (!ratings.length) return { overall: null, count: 0, arrival: null, care: null, communication: null };
  const overall = ratings.reduce((s, r) => s + r.stars, 0) / ratings.length;
  const round = (n: number) => Math.round(Math.min(5, Math.max(1, n)) * 10) / 10;
  const dim = (d: RatingDimension) => {
    const { good, bad } = RATING_DIMENSIONS[d];
    let g = 0;
    let b = 0;
    for (const r of ratings) {
      if (r.tags.some((t) => (good as readonly string[]).includes(t))) g++;
      if (r.tags.some((t) => (bad as readonly string[]).includes(t))) b++;
    }
    return round(overall + ((g - b) / ratings.length) * 0.5);
  };
  return { overall: round(overall), count: ratings.length, arrival: dim('arrival'), care: dim('care'), communication: dim('communication') };
}
