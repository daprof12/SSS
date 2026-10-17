import { describe, expect, it } from 'vitest';
import {
  addMonth,
  agencyFeatures,
  agencyInvoiceMachine,
  agencyMachine,
  agencyStates,
  applyEvent,
  approve,
  availableEvents,
  classifyPlanChange,
  dispatchingAgencyStates,
  emailEvidence,
  monthlyLines,
  namesMatch,
  onboardingQuote,
  prorate,
  reachableStates,
  requiredAgencyDocuments,
  type AgencyActor,
  type AgencyEvent,
  type AgencyPrice,
  type AgencyState,
} from './index';

const run = (steps: Array<[AgencyEvent, AgencyActor]>, from: AgencyState = 'registering') => {
  let s = from;
  for (const [e, a] of steps) {
    const r = applyEvent(agencyMachine, s, e, a);
    if (!r.ok) throw new Error(`${e} from ${s}: ${r.message}`);
    s = r.to;
  }
  return s;
};

describe('agency machine (UX Gap Analysis §10)', () => {
  it('declares exactly the states in the agencies.status check constraint, all reachable', () => {
    expect([...reachableStates(agencyMachine)].sort()).toEqual([...agencyStates].sort());
  });

  it('runs register → live → overdue → live → offboarded', () => {
    expect(
      run([
        ['submit', 'agency_admin'],
        ['start_review', 'platform_admin'],
        ['approve', 'platform_admin'],
        ['choose_plan', 'agency_admin'],
        ['fee_paid', 'system'],
        ['go_live', 'agency_admin'],
        ['invoice_overdue', 'system'],
        ['payment_received', 'system'],
        ['request_offboard', 'agency_admin'],
        ['complete_offboard', 'platform_admin'],
      ]),
    ).toBe('offboarded');
  });

  it('loops "ask for more" back to the documents step', () => {
    const s = run([
      ['submit', 'agency_admin'],
      ['start_review', 'platform_admin'],
      ['ask_more', 'platform_admin'],
    ]);
    expect(s).toBe('more_info_needed');
    expect(agencyFeatures[s].editApplication).toBe(true);
    expect(run([['submit', 'agency_admin']], s)).toBe('documents_submitted');
  });

  it('locks editing under review and makes reject final', () => {
    expect(agencyFeatures.documents_submitted.editApplication).toBe(false);
    expect(agencyFeatures.in_review.editApplication).toBe(false);
    expect(applyEvent(agencyMachine, 'rejected', 'submit', 'agency_admin')).toMatchObject({ ok: false, code: 'terminal_state' });
  });

  it('keeps decisions with the platform and payment confirmation with the system', () => {
    expect(applyEvent(agencyMachine, 'in_review', 'approve', 'agency_admin')).toMatchObject({ ok: false, code: 'actor_not_allowed' });
    // The agency cannot mark its own fee as paid; only a webhook or finance can.
    expect(applyEvent(agencyMachine, 'fee_pending', 'fee_paid', 'agency_admin')).toMatchObject({ ok: false, code: 'actor_not_allowed' });
    expect(applyEvent(agencyMachine, 'fee_pending', 'fee_paid', 'platform_admin')).toMatchObject({ ok: false, code: 'actor_not_allowed' });
    expect(applyEvent(agencyMachine, 'approved', 'go_live', 'agency_admin')).toMatchObject({ ok: false, code: 'invalid_transition' });
    expect(availableEvents(agencyMachine, 'in_review', 'platform_admin').sort()).toEqual(['approve', 'ask_more', 'reject']);
    expect(availableEvents(agencyMachine, 'live', 'agency_admin')).toEqual(['request_offboard']);
  });

  it('never stops dispatch for billing, and holds new stations and equipment while overdue', () => {
    expect(agencyFeatures.overdue).toMatchObject({ dispatch: true, addStations: false, addInventory: false });
    expect(agencyFeatures.live).toMatchObject({ dispatch: true, addStations: true });
    expect([...dispatchingAgencyStates].sort()).toEqual(['live', 'offboarding', 'overdue']);
  });
});

describe('agency invoice machine', () => {
  it('pays by webhook (system) or by finance marking a transfer (platform admin)', () => {
    expect(applyEvent(agencyInvoiceMachine, 'issued', 'payment_confirmed', 'system')).toMatchObject({ ok: true, to: 'paid' });
    expect(applyEvent(agencyInvoiceMachine, 'overdue', 'transfer_marked', 'platform_admin')).toMatchObject({ ok: true, to: 'paid' });
    expect(applyEvent(agencyInvoiceMachine, 'issued', 'transfer_marked', 'system')).toMatchObject({ ok: false, code: 'actor_not_allowed' });
    expect(applyEvent(agencyInvoiceMachine, 'paid', 'waive', 'platform_admin')).toMatchObject({ ok: false, code: 'terminal_state' });
    expect(applyEvent(agencyInvoiceMachine, 'draft', 'mark_overdue', 'system')).toMatchObject({ ok: false, code: 'invalid_transition' });
  });
});

describe('agency registration rules', () => {
  it('asks "other" bodies for their registration too', () => {
    expect(requiredAgencyDocuments('police')).toHaveLength(4);
    expect(requiredAgencyDocuments('other')).toContain('registration_certificate');
  });

  it('flags government domains as stronger evidence', () => {
    expect(emailEvidence('ops@frsc.gov.ng')).toBe('government_domain');
    expect(emailEvidence('x@army.mil.ng')).toBe('government_domain');
    expect(emailEvidence('x@gmail.com')).toBe('other_domain');
    expect(emailEvidence('x@notgov.ng')).toBe('other_domain');
  });

  it('matches payout account names to the signatory regardless of order and case', () => {
    expect(namesMatch('ADEYEMI Tunde O.', 'Tunde O Adeyemi')).toBe(true);
    expect(namesMatch('Tunde Adeyemi', 'Bola Adeyemi')).toBe(false);
  });
});

describe('agency pricing', () => {
  const prices: Record<string, AgencyPrice> = {
    onboarding: { code: 'onboarding', label: 'Onboarding', amountKobo: 50_000_00 },
    agency_base: { code: 'agency_base', label: 'Base', amountKobo: 10_000_00, includes: { stations: 2 } },
    addon_extra_station: { code: 'addon_extra_station', label: 'Extra station', amountKobo: 2_000_00, includes: { stations: 1 } },
    addon_messaging: { code: 'addon_messaging', label: 'Messaging credits', amountKobo: 1_000_00, includes: { messages: 100 } },
    station_overage: { code: 'station_overage', label: 'Station over allowance', amountKobo: 3_000_00 },
    inventory_drone_kit: { code: 'inventory_drone_kit', label: 'Drone kit', amountKobo: 500_00 },
    messaging_sms: { code: 'messaging_sms', label: 'SMS', amountKobo: 4_00 },
  };

  it('quotes onboarding fee + first period with VAT', () => {
    const q = onboardingQuote({ prices, basePlan: 'agency_base', addons: { addon_extra_station: 1 }, vatRate: 0.075 });
    expect(q.subtotalKobo).toBe(62_000_00);
    expect(q.vatKobo).toBe(4_650_00);
    expect(q.totalKobo).toBe(66_650_00);
    expect(q.monthlyKobo).toBe(12_900_00);
  });

  it('bills stations beyond the allowance, inventory and messaging beyond credits', () => {
    const lines = monthlyLines({
      prices,
      basePlan: 'agency_base',
      addons: { addon_extra_station: 1, addon_messaging: 1 },
      stationCount: 5,
      inventory: { inventory_drone_kit: 2 },
      usage: { messaging_sms: 130 },
      vatRate: 0,
    });
    expect(lines.map((l) => [l.code, l.quantity])).toEqual([
      ['agency_base', 1],
      ['addon_extra_station', 1],
      ['addon_messaging', 1],
      ['station_overage', 2],
      ['inventory_drone_kit', 2],
      ['messaging_sms', 30],
    ]);
  });

  it('prorates upgrades to the days left and rolls months over safely', () => {
    const start = new Date('2026-10-01');
    const end = addMonth(start);
    expect(end.toISOString().slice(0, 10)).toBe('2026-11-01');
    expect(prorate(31_000_00, start, end, new Date('2026-10-17'))).toBe(15_000_00);
    expect(prorate(-100, start, end, new Date('2026-10-17'))).toBe(0);
    expect(addMonth(new Date('2026-01-31')).toISOString().slice(0, 10)).toBe('2026-02-28');
  });

  it('upgrades now and downgrades at period end', () => {
    expect(classifyPlanChange({ addon_extra_station: 1 }, { addon_extra_station: 3, addon_messaging: 0 })).toEqual([
      { code: 'addon_extra_station', from: 1, to: 3, when: 'now' },
    ]);
    expect(classifyPlanChange({ addon_messaging: 2 }, { addon_messaging: 1 })).toEqual([{ code: 'addon_messaging', from: 2, to: 1, when: 'period_end' }]);
  });
});

describe('dual control', () => {
  it('needs two different people above the threshold', () => {
    const first = approve({ amountKobo: 1_000_000, thresholdKobo: 500_000, approvals: [], approverId: 'a' });
    expect(first).toEqual({ ok: true, complete: false, approvals: ['a'] });
    expect(approve({ amountKobo: 1_000_000, thresholdKobo: 500_000, approvals: ['a'], approverId: 'a' })).toMatchObject({ ok: false, code: 'same_approver' });
    expect(approve({ amountKobo: 1_000_000, thresholdKobo: 500_000, approvals: ['a'], approverId: 'b' })).toMatchObject({ ok: true, complete: true });
    expect(approve({ amountKobo: 500_000, thresholdKobo: 500_000, approvals: [], approverId: 'a' })).toMatchObject({ ok: true, complete: true });
  });
});
