// Incident lifecycle — document/Report Tracking and Data Flow.md §A2/A3.
import { applyEvent, defineMachine, type TransitionResult } from './machine';

export const incidentStates = [
  'pending_cancel',
  'received',
  'offered',
  'escalated',
  'accepted',
  'en_route',
  'reassigning',
  'transferred',
  'on_scene',
  'closing',
  'resolved',
  'unfounded',
  'cancelled',
  'merged',
] as const;
export type IncidentState = (typeof incidentStates)[number];

export type IncidentActor = 'reporter' | 'officer' | 'station' | 'platform_admin' | 'system';

export type IncidentEvent =
  | 'cancel_in_window'
  | 'window_elapsed'
  | 'route'
  | 'assign'
  | 'accept'
  | 'offer_timeout'
  | 'reoffer'
  | 'start_route'
  | 'officer_drop'
  | 'transfer'
  | 'arrive'
  | 'begin_close'
  | 'close_valid'
  | 'close_unfounded'
  | 'reporter_cancel'
  | 'merge_into';

const live = ['received', 'offered', 'escalated', 'accepted', 'en_route', 'reassigning', 'transferred', 'on_scene'] as const;

export const incidentMachine = defineMachine<IncidentState, IncidentEvent, IncidentActor>({
  name: 'incident',
  initial: 'pending_cancel',
  terminal: ['resolved', 'unfounded', 'cancelled', 'merged'],
  transitions: [
    { event: 'cancel_in_window', from: ['pending_cancel'], to: 'cancelled', actors: ['reporter'] },
    { event: 'window_elapsed', from: ['pending_cancel'], to: 'received', actors: ['system'] },
    { event: 'route', from: ['received', 'transferred', 'reassigning'], to: 'offered', actors: ['system'] },
    { event: 'assign', from: ['received', 'escalated', 'reassigning', 'transferred'], to: 'offered', actors: ['station'] },
    { event: 'accept', from: ['offered'], to: 'accepted', actors: ['officer'] },
    { event: 'offer_timeout', from: ['offered'], to: 'escalated', actors: ['system'] },
    { event: 'reoffer', from: ['escalated'], to: 'offered', actors: ['system'] },
    { event: 'start_route', from: ['accepted'], to: 'en_route', actors: ['officer', 'system'] },
    { event: 'officer_drop', from: ['accepted', 'en_route'], to: 'reassigning', actors: ['officer', 'station'] },
    {
      event: 'transfer',
      from: ['offered', 'escalated', 'accepted', 'en_route', 'on_scene'],
      to: 'transferred',
      actors: ['station'],
    },
    { event: 'arrive', from: ['accepted', 'en_route'], to: 'on_scene', actors: ['officer', 'system'] },
    {
      event: 'begin_close',
      from: ['on_scene', 'accepted', 'en_route', 'escalated', 'offered'],
      to: 'closing',
      actors: ['officer', 'station'],
    },
    { event: 'close_valid', from: ['closing'], to: 'resolved', actors: ['officer', 'station'] },
    { event: 'close_unfounded', from: ['closing'], to: 'unfounded', actors: ['officer', 'station'] },
    {
      event: 'reporter_cancel',
      from: ['received', 'offered', 'escalated', 'accepted', 'en_route', 'reassigning', 'transferred'],
      to: 'cancelled',
      actors: ['reporter'],
    },
    { event: 'merge_into', from: [...live], to: 'merged', actors: ['station', 'system'] },
  ],
});

/** Events that add to the log without changing state (A2: reinforce is an event, not a state). */
export const incidentSideEvents = [
  'reinforce',
  'add_info',
  'note',
  'officer_panic',
  'panic_cleared',
  'report_joined',
  'split',
  'eta_changed',
  'statement_requested',
  'drone_requested',
  'transfer_requested',
] as const;
export type IncidentSideEvent = (typeof incidentSideEvents)[number];

export const sideEventAllowedIn: Record<IncidentSideEvent, readonly IncidentState[]> = {
  reinforce: ['accepted', 'en_route', 'on_scene'],
  add_info: [...live],
  note: [...live, 'closing'],
  officer_panic: ['accepted', 'en_route', 'on_scene', 'closing'],
  panic_cleared: ['accepted', 'en_route', 'on_scene', 'closing', 'resolved', 'unfounded', 'cancelled'],
  report_joined: [...live],
  split: [...live],
  eta_changed: ['accepted', 'en_route'],
  statement_requested: ['on_scene', 'closing', 'resolved'],
  drone_requested: ['accepted', 'en_route', 'on_scene'],
  transfer_requested: ['on_scene', 'closing'],
};

export const incidentTimers = {
  cancelRingSeconds: 5,
  freeCancelSeconds: 30,
  defaultAcceptWindowSeconds: 25,
  escalationNoticeSeconds: 60,
  staleAfterSeconds: 20,
  smsFallbackAfterSeconds: 20,
  rateReminderHours: 24,
  contactLinkTtlHoursAfterClose: 2,
} as const;

export interface CancelAssessment {
  /** No fine possible: inside the free window or before anyone was offered. */
  free: boolean;
  /** Cancelled after dispatch — recorded, never blocked (SRS REP-7). */
  flagged: boolean;
}

export function assessReporterCancel(state: IncidentState, secondsSinceReceived: number): CancelAssessment {
  const beforeDispatch = state === 'received';
  const free = beforeDispatch || secondsSinceReceived <= incidentTimers.freeCancelSeconds;
  return { free, flagged: !beforeDispatch };
}

export function applyIncidentEvent(
  state: IncidentState,
  event: IncidentEvent,
  actor: IncidentActor,
): TransitionResult<IncidentState> {
  return applyEvent(incidentMachine, state, event, actor);
}

export const isLive = (s: IncidentState) => (live as readonly string[]).includes(s);

/** Officer and reporter positions are only shared on the way (A5). */
export const sharesLiveLocation = (s: IncidentState) => s === 'accepted' || s === 'en_route';

// --- Report delivery: one sender's own layer (A1) ---------------------------------
export const reportDeliveryStates = ['sending', 'queued_offline', 'sms_sent', 'submitted', 'failed'] as const;
export type ReportDeliveryState = (typeof reportDeliveryStates)[number];

export const reportDeliveryMachine = defineMachine<
  ReportDeliveryState,
  'go_offline' | 'send_sms' | 'server_ack' | 'give_up',
  'device' | 'system'
>({
  name: 'report delivery',
  initial: 'sending',
  terminal: ['submitted'],
  transitions: [
    { event: 'go_offline', from: ['sending'], to: 'queued_offline', actors: ['device'] },
    { event: 'send_sms', from: ['queued_offline', 'sending', 'failed'], to: 'sms_sent', actors: ['device'] },
    { event: 'server_ack', from: ['sending', 'queued_offline', 'sms_sent', 'failed'], to: 'submitted', actors: ['system'] },
    // A report is never dropped: "failed" keeps retrying and offers SMS again.
    { event: 'give_up', from: ['queued_offline'], to: 'failed', actors: ['device'] },
  ],
});
