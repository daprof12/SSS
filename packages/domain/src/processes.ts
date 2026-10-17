// Every other tracked process — Report Tracking and Data Flow, Part B.
// Each has a machine so every party can see the same current state.
import { defineMachine } from './machine';

type Sys = 'system';

// B4 — household subscription. Decided 2026-10-17: billing starts at install.
export const subscriptionMachine = defineMachine<
  'draft' | 'install_pending' | 'install_booked' | 'active' | 'grace' | 'extras_paused' | 'sharing_paused' | 'switched_off' | 'paused' | 'cancelled',
  'pay_install_fee' | 'book_visit' | 'install_confirmed' | 'charge_failed' | 'stage_advance' | 'payment_received' | 'pause' | 'resume' | 'cancel',
  'owner' | 'technician' | 'platform_admin' | Sys
>({
  name: 'subscription',
  initial: 'draft',
  terminal: ['cancelled'],
  transitions: [
    { event: 'pay_install_fee', from: ['draft'], to: 'install_pending', actors: ['system'] },
    { event: 'book_visit', from: ['install_pending'], to: 'install_booked', actors: ['owner', 'platform_admin'] },
    // Owner gives the technician the confirmation code; first period starts now.
    { event: 'install_confirmed', from: ['install_booked'], to: 'active', actors: ['technician'] },
    { event: 'charge_failed', from: ['active'], to: 'grace', actors: ['system'] },
    { event: 'stage_advance', from: ['grace'], to: 'extras_paused', actors: ['system'] },
    { event: 'stage_advance', from: ['extras_paused'], to: 'sharing_paused', actors: ['system'] },
    { event: 'stage_advance', from: ['sharing_paused'], to: 'switched_off', actors: ['system'] },
    // "Paying at any point restores everything the same day."
    { event: 'payment_received', from: ['grace', 'extras_paused', 'sharing_paused', 'switched_off'], to: 'active', actors: ['system'] },
    { event: 'pause', from: ['active', 'grace'], to: 'paused', actors: ['owner', 'platform_admin'] },
    { event: 'resume', from: ['paused'], to: 'active', actors: ['owner', 'platform_admin'] },
    { event: 'cancel', from: ['draft', 'install_pending', 'install_booked', 'active', 'grace', 'extras_paused', 'sharing_paused', 'switched_off', 'paused'], to: 'cancelled', actors: ['owner', 'platform_admin'] },
  ],
});

/** Paid extras by dunning stage. Emergency reporting is never in this table. */
export const subscriptionFeatures = {
  active: { liveView: true, clipHistory: true, householdSharing: true, feedsToResponders: true, devicesOn: true },
  grace: { liveView: true, clipHistory: true, householdSharing: true, feedsToResponders: true, devicesOn: true },
  extras_paused: { liveView: false, clipHistory: false, householdSharing: false, feedsToResponders: true, devicesOn: true },
  sharing_paused: { liveView: false, clipHistory: false, householdSharing: false, feedsToResponders: false, devicesOn: true },
  switched_off: { liveView: false, clipHistory: false, householdSharing: false, feedsToResponders: false, devicesOn: false },
} as const;

// B9 — withdrawal.
export const withdrawalMachine = defineMachine<
  'requested' | 'held_first' | 'processing' | 'sent' | 'arrived' | 'failed_refunded',
  'hold_first' | 'release' | 'submit' | 'transfer_success' | 'bank_confirmed' | 'transfer_failed',
  Sys
>({
  name: 'withdrawal',
  initial: 'requested',
  terminal: ['arrived', 'failed_refunded'],
  transitions: [
    { event: 'hold_first', from: ['requested'], to: 'held_first', actors: ['system'] },
    { event: 'release', from: ['held_first'], to: 'processing', actors: ['system'] },
    { event: 'submit', from: ['requested'], to: 'processing', actors: ['system'] },
    { event: 'transfer_success', from: ['processing'], to: 'sent', actors: ['system'] },
    { event: 'bank_confirmed', from: ['sent'], to: 'arrived', actors: ['system'] },
    { event: 'transfer_failed', from: ['processing', 'sent'], to: 'failed_refunded', actors: ['system'] },
  ],
});

// B2 — tip and bounty claim.
export const tipMachine = defineMachine<
  'sent' | 'in_queue' | 'more_info' | 'claim_review' | 'approved_held' | 'available' | 'declined' | 'closed_no_result' | 'found_false',
  'route' | 'ask_more' | 'info_added' | 'outcome_recorded' | 'approve' | 'decline' | 'hold_ends' | 'close' | 'mark_false',
  'agency_admin' | 'tipper' | Sys
>({
  name: 'tip',
  initial: 'sent',
  terminal: ['available', 'declined', 'closed_no_result', 'found_false'],
  transitions: [
    { event: 'route', from: ['sent'], to: 'in_queue', actors: ['system'] },
    { event: 'ask_more', from: ['in_queue', 'claim_review'], to: 'more_info', actors: ['agency_admin'] },
    { event: 'info_added', from: ['more_info'], to: 'in_queue', actors: ['tipper'] },
    { event: 'outcome_recorded', from: ['in_queue'], to: 'claim_review', actors: ['agency_admin'] },
    { event: 'approve', from: ['claim_review'], to: 'approved_held', actors: ['agency_admin'] },
    { event: 'decline', from: ['claim_review'], to: 'declined', actors: ['agency_admin'] },
    { event: 'hold_ends', from: ['approved_held'], to: 'available', actors: ['system'] },
    { event: 'close', from: ['in_queue', 'more_info'], to: 'closed_no_result', actors: ['agency_admin'] },
    { event: 'mark_false', from: ['in_queue', 'claim_review'], to: 'found_false', actors: ['agency_admin'] },
  ],
});

// B10 — invitations (officers, heads, members, technicians, staff).
export const inviteMachine = defineMachine<
  'sent' | 'opened' | 'verifying' | 'pending_approval' | 'active' | 'expired' | 'revoked',
  'open' | 'start_verification' | 'verified' | 'approve' | 'expire' | 'revoke' | 'resend',
  'inviter' | 'invitee' | Sys
>({
  name: 'invite',
  initial: 'sent',
  terminal: ['active', 'revoked'],
  transitions: [
    { event: 'open', from: ['sent'], to: 'opened', actors: ['invitee'] },
    { event: 'start_verification', from: ['opened'], to: 'verifying', actors: ['invitee'] },
    { event: 'verified', from: ['verifying'], to: 'pending_approval', actors: ['system'] },
    { event: 'approve', from: ['pending_approval'], to: 'active', actors: ['inviter'] },
    { event: 'expire', from: ['sent', 'opened', 'verifying'], to: 'expired', actors: ['system'] },
    { event: 'resend', from: ['expired'], to: 'sent', actors: ['inviter'] },
    { event: 'revoke', from: ['sent', 'opened', 'verifying', 'pending_approval', 'expired'], to: 'revoked', actors: ['inviter'] },
  ],
});

// B4/B5 — technician job (install or repair).
export const jobMachine = defineMachine<
  'unassigned' | 'scheduled' | 'quote_pending' | 'en_route' | 'on_site' | 'awaiting_devices' | 'awaiting_customer_code' | 'done' | 'cancelled',
  'assign' | 'send_quote' | 'quote_accepted' | 'depart' | 'arrive' | 'installed' | 'devices_online' | 'customer_code_ok' | 'cancel' | 'reschedule',
  'platform_admin' | 'technician' | 'owner' | Sys
>({
  name: 'job',
  initial: 'unassigned',
  terminal: ['done', 'cancelled'],
  transitions: [
    { event: 'assign', from: ['unassigned'], to: 'scheduled', actors: ['platform_admin'] },
    { event: 'send_quote', from: ['scheduled', 'on_site'], to: 'quote_pending', actors: ['technician', 'platform_admin'] },
    { event: 'quote_accepted', from: ['quote_pending'], to: 'scheduled', actors: ['owner'] },
    { event: 'depart', from: ['scheduled'], to: 'en_route', actors: ['technician'] },
    { event: 'arrive', from: ['en_route'], to: 'on_site', actors: ['technician'] },
    { event: 'installed', from: ['on_site'], to: 'awaiting_devices', actors: ['technician'] },
    // "Device must report before closing" (admin Install job board).
    { event: 'devices_online', from: ['awaiting_devices'], to: 'awaiting_customer_code', actors: ['system'] },
    { event: 'customer_code_ok', from: ['awaiting_customer_code'], to: 'done', actors: ['technician'] },
    { event: 'reschedule', from: ['scheduled', 'en_route', 'quote_pending'], to: 'unassigned', actors: ['platform_admin', 'owner'] },
    { event: 'cancel', from: ['unassigned', 'scheduled', 'quote_pending'], to: 'cancelled', actors: ['platform_admin'] },
  ],
});

// B8 — fines. Warnings come first by policy and are records, not fines.
export const fineMachine = defineMachine<
  'open' | 'appealed' | 'waived' | 'reduced' | 'upheld' | 'paid',
  'appeal' | 'waive' | 'reduce' | 'uphold' | 'pay',
  'citizen' | 'platform_admin' | Sys
>({
  name: 'fine',
  initial: 'open',
  terminal: ['waived', 'paid'],
  transitions: [
    { event: 'appeal', from: ['open'], to: 'appealed', actors: ['citizen'] },
    { event: 'waive', from: ['open', 'appealed'], to: 'waived', actors: ['platform_admin'] },
    { event: 'reduce', from: ['appealed'], to: 'reduced', actors: ['platform_admin'] },
    { event: 'uphold', from: ['appealed'], to: 'upheld', actors: ['platform_admin'] },
    { event: 'pay', from: ['open', 'reduced', 'upheld'], to: 'paid', actors: ['citizen', 'system'] },
  ],
});
