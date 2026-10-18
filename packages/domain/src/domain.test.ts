import { describe, expect, it } from 'vitest';
import {
  agencyHandles,
  bankName,
  checkPin,
  isNuban,
  subRatings,
  checkLearnPost,
  learnPostMachine,
  rankForYou,
  bountyFee,
  checkFeeSettings,
  effectiveFeeBps,
  percent,
  transferFee,
  bountyRangeText,
  suggestBounty,
  accountDeletionBlockers,
  agencyInvoiceMachine,
  agencyMachine,
  applyIncidentEvent,
  assessReporterCancel,
  availableEvents,
  checkWithdrawal,
  citizenStatus,
  fineMachine,
  issueMachine,
  issueStatus,
  tipStatus,
  soundsUrgent,
  tipCategories,
  issueCategories,
  formatNaira,
  freshness,
  incidentMachine,
  incidentStates,
  inviteMachine,
  jobMachine,
  kobo,
  naira,
  projectIncident,
  reachableStates,
  reportDeliveryMachine,
  subscriptionMachine,
  tipMachine,
  withdrawalMachine,
  ForbiddenView,
  type IncidentEvent,
  type IncidentRecord,
  type IncidentState,
} from './index';

const machines = [issueMachine, incidentMachine, reportDeliveryMachine, subscriptionMachine, withdrawalMachine, tipMachine, inviteMachine, jobMachine, fineMachine, agencyMachine, agencyInvoiceMachine];

describe.each(machines.map((m) => [m.name, m] as const))('%s machine', (_name, m) => {
  it('reaches every state it declares and every terminal state', () => {
    const declared = new Set<string>([m.initial, ...m.transitions.flatMap((t) => [...t.from, t.to])]);
    const reached = reachableStates(m as never) as Set<string>;
    for (const s of declared) expect(reached.has(s), `${s} unreachable`).toBe(true);
    for (const t of m.terminal) expect(reached.has(t), `terminal ${t} unreachable`).toBe(true);
  });
});

describe('incident machine', () => {
  const run = (steps: Array<[IncidentEvent, Parameters<typeof applyIncidentEvent>[2]]>) => {
    let s: IncidentState = 'pending_cancel';
    for (const [e, a] of steps) {
      const r = applyIncidentEvent(s, e, a);
      if (!r.ok) throw new Error(`${e} from ${s}: ${r.message}`);
      s = r.to;
    }
    return s;
  };

  it('covers every declared state', () => {
    expect([...reachableStates(incidentMachine)].sort()).toEqual([...incidentStates].sort());
  });

  it('runs the happy path to resolved', () => {
    expect(
      run([
        ['window_elapsed', 'system'],
        ['route', 'system'],
        ['accept', 'officer'],
        ['start_route', 'officer'],
        ['arrive', 'officer'],
        ['begin_close', 'officer'],
        ['close_valid', 'officer'],
      ]),
    ).toBe('resolved');
  });

  it('escalates, reassigns and transfers without losing the incident', () => {
    expect(
      run([
        ['window_elapsed', 'system'],
        ['route', 'system'],
        ['offer_timeout', 'system'],
        ['reoffer', 'system'],
        ['accept', 'officer'],
        ['officer_drop', 'officer'],
        ['route', 'system'],
        ['accept', 'officer'],
        ['transfer', 'station'],
        ['route', 'system'],
        ['accept', 'officer'],
      ]),
    ).toBe('accepted');
  });

  it('never lets a reporter accept or close, or an officer cancel for the reporter', () => {
    expect(applyIncidentEvent('offered', 'accept', 'reporter')).toMatchObject({ ok: false, code: 'actor_not_allowed' });
    expect(applyIncidentEvent('closing', 'close_unfounded', 'reporter')).toMatchObject({ ok: false });
    expect(applyIncidentEvent('en_route', 'reporter_cancel', 'officer')).toMatchObject({ ok: false, code: 'actor_not_allowed' });
  });

  it('refuses moves out of terminal states', () => {
    expect(applyIncidentEvent('resolved', 'accept', 'officer')).toMatchObject({ ok: false, code: 'terminal_state' });
  });

  it('cannot mark on scene before accepting (States doc)', () => {
    expect(applyIncidentEvent('offered', 'arrive', 'officer')).toMatchObject({ ok: false, code: 'invalid_transition' });
  });

  it('gives buttons per actor and state', () => {
    expect(availableEvents(incidentMachine, 'offered', 'officer').sort()).toEqual(['accept', 'begin_close']);
    expect(availableEvents(incidentMachine, 'en_route', 'reporter')).toEqual(['reporter_cancel']);
  });

  it('flags a cancel after dispatch but never blocks it', () => {
    expect(assessReporterCancel('received', 300)).toEqual({ free: true, flagged: false });
    expect(assessReporterCancel('offered', 20)).toEqual({ free: true, flagged: true });
    expect(assessReporterCancel('en_route', 120)).toEqual({ free: false, flagged: true });
  });
});

describe('citizen tracking', () => {
  it('always has a title and line for every state', () => {
    for (const s of incidentStates) {
      const st = citizenStatus(s);
      expect(st.title.length, s).toBeGreaterThan(0);
      expect(st.line.length, s).toBeGreaterThan(0);
    }
  });

  it('shows the officer and ETA once accepted', () => {
    const st = citizenStatus('en_route', { officerName: 'Insp. Musa', etaMinutes: 6 });
    expect(st).toMatchObject({ title: 'On the way', line: 'About 6 min.', holder: 'Insp. Musa', showOfficerCard: true, step: 3 });
  });

  it('tells joiners how many others reported', () => {
    expect(citizenStatus('accepted', { joined: true, reportCount: 3 }).line).toMatch(/^You and 2 others reported this\./);
  });

  it('hides names in discreet mode', () => {
    const st = citizenStatus('accepted', { officerName: 'Insp. Musa', discreet: true });
    expect(st.title).toBe('Request in progress');
    expect(JSON.stringify(st)).not.toContain('Musa');
  });

  it('reports freshness: live, stale, reconnecting with SMS', () => {
    const now = new Date('2026-10-17T12:00:30Z');
    expect(freshness(new Date('2026-10-17T12:00:25Z'), now, true)).toEqual({ kind: 'live' });
    expect(freshness(new Date('2026-10-17T12:00:00Z'), now, true)).toEqual({ kind: 'stale', secondsAgo: 30 });
    expect(freshness(new Date('2026-10-17T12:00:00Z'), now, false)).toEqual({ kind: 'reconnecting', smsUpdates: true });
  });
});

describe('role-filtered incident views', () => {
  const record: IncidentRecord = {
    id: 'inc-1',
    type: 'robbery',
    state: 'en_route',
    agencyId: 'ag-police',
    stationId: 'st-4',
    reporter: { userId: 'u-ada', name: 'Ada Obi', phone: '+2348030000000', trustScore: 82, trustBand: 'high' },
    joinerUserIds: ['u-joiner'],
    reportCount: 2,
    building: { postcode: 'AB12C', address: '12 Maple Road', areaLabel: 'Maple area, Ikeja', location: { lat: 6.6, lng: 3.35 } },
    reporterGps: { lat: 6.6001, lng: 3.3501 },
    assignedOfficerIds: ['u-musa'],
    officer: { id: 'u-musa', name: 'Insp. Musa', badgeNo: 'B-77', stationName: 'Station 4', rating: 4.8, location: { lat: 6.61, lng: 3.36 } },
    etaMinutes: 6,
    brief: { summary: '2 people, light sedan', confidence: 'medium', fields: {} },
    clipIds: ['clip-1'],
    timeline: [
      { at: 't1', kind: 'received', label: 'Report received', public: true },
      { at: 't2', kind: 'note', label: 'Note by dispatcher', public: false },
    ],
    notes: [{ by: 'u-musa', text: 'Rear door open', at: 't3' }],
    createdAt: 't0',
    updatedAt: 't3',
  };
  const str = (v: unknown) => JSON.stringify(v);

  it('never sends the reporter phone to anyone', () => {
    const viewers = [
      { kind: 'reporter', userId: 'u-ada' },
      { kind: 'joiner', userId: 'u-joiner' },
      { kind: 'contact', reporterOptedInLocation: true },
      { kind: 'officer', userId: 'u-musa' },
      { kind: 'station', stationId: 'st-4' },
      { kind: 'agency', agencyId: 'ag-police' },
      { kind: 'platform_admin' },
    ] as const;
    for (const v of viewers) expect(str(projectIncident(record, v)), v.kind).not.toContain('+234803');
  });

  it('gives joiners and contacts the area, not the building or who reported', () => {
    for (const v of [{ kind: 'joiner', userId: 'u-joiner' }, { kind: 'contact', reporterOptedInLocation: false }] as const) {
      const out = str(projectIncident(record, v));
      expect(out).toContain('Maple area, Ikeja');
      expect(out).not.toContain('12 Maple Road');
      expect(out).not.toContain('AB12C');
      if (v.kind === 'joiner') expect(out).not.toContain('Ada');
    }
  });

  it('keeps the AI brief and private notes from citizens', () => {
    const out = str(projectIncident(record, { kind: 'reporter', userId: 'u-ada' }));
    expect(out).not.toContain('light sedan');
    expect(out).not.toContain('Rear door');
    expect(out).not.toContain('Note by dispatcher');
  });

  it('labels the brief advisory for responders and hides the reporter name from officers', () => {
    const v = projectIncident(record, { kind: 'officer', userId: 'u-musa' });
    expect(v).toMatchObject({ brief: { advisory: true }, reporter: { label: 'Verified citizen', trustBand: 'high' } });
    expect(str(v)).not.toContain('Ada');
  });

  it('stops sharing locations once on scene', () => {
    const onScene = { ...record, state: 'on_scene' as const };
    expect(projectIncident(onScene, { kind: 'reporter', userId: 'u-ada' })).toMatchObject({ officerLocation: undefined, etaMinutes: undefined });
    expect(projectIncident(onScene, { kind: 'officer', userId: 'u-musa' })).toMatchObject({ reporterGps: undefined });
  });

  it('refuses viewers outside the incident', () => {
    expect(() => projectIncident(record, { kind: 'reporter', userId: 'u-other' })).toThrow(ForbiddenView);
    expect(() => projectIncident(record, { kind: 'officer', userId: 'u-other' })).toThrow(ForbiddenView);
    expect(() => projectIncident(record, { kind: 'station', stationId: 'st-9' })).toThrow(ForbiddenView);
    expect(() => projectIncident(record, { kind: 'agency', agencyId: 'ag-fire' })).toThrow(ForbiddenView);
  });

  it('shares the reporter location with a contact only when opted in and on the way', () => {
    expect(projectIncident(record, { kind: 'contact', reporterOptedInLocation: true })).toMatchObject({ reporterLocation: { lat: 6.6001 } });
    expect(projectIncident(record, { kind: 'contact', reporterOptedInLocation: false })).toMatchObject({ reporterLocation: undefined });
  });
});

describe('money', () => {
  const limits = { minFund: naira(100), maxFundPerTxn: naira(500_000), minWithdraw: naira(1_000), dailyWithdrawLimit: naira(200_000) };

  it('rejects fractional kobo', () => {
    expect(() => kobo(1.5)).toThrow();
  });

  it('validates withdrawals with the final copy', () => {
    const base = { available: naira(50_000), withdrawnToday: naira(0), limits, bank: { nameMatches: true } };
    expect(checkWithdrawal({ ...base, amount: naira(500) })).toMatchObject({ ok: false, field: 'amount' });
    expect(checkWithdrawal({ ...base, amount: naira(60_000) })).toEqual({ ok: false, field: 'amount', message: 'You do not have that much available.' });
    expect(checkWithdrawal({ ...base, amount: naira(10_000), withdrawnToday: naira(195_000) })).toMatchObject({ ok: false, message: expect.stringContaining('today') });
    expect(checkWithdrawal({ ...base, amount: naira(10_000), bank: { nameMatches: false } })).toMatchObject({ ok: false, field: 'bank' });
    expect(checkWithdrawal({ ...base, amount: naira(10_000) })).toEqual({ ok: true });
  });

  it('formats naira', () => {
    expect(formatNaira(naira(1234.5))).toBe('₦1,234.50');
    expect(formatNaira(naira(-20), { sign: true })).toBe('-₦20.00');
  });

  it('blocks account deletion until everything is settled', () => {
    expect(
      accountDeletionBlockers({ walletBalance: naira(10), heldBalance: kobo(0), openFines: 1, pendingWithdrawals: 0, activeSubscription: true }),
    ).toEqual(['wallet_balance', 'open_fines', 'active_subscription']);
    expect(
      accountDeletionBlockers({ walletBalance: kobo(0), heldBalance: kobo(0), openFines: 0, pendingWithdrawals: 0, activeSubscription: false }),
    ).toEqual([]);
  });
});

describe('subscription billing starts at install', () => {
  it('is not active until the technician confirms the install', () => {
    let s: string = subscriptionMachine.initial;
    for (const [e, a] of [
      ['pay_install_fee', 'system'],
      ['book_visit', 'owner'],
    ] as const) {
      const r = availableEvents(subscriptionMachine, s as never, a);
      expect(r).toContain(e);
      s = subscriptionMachine.transitions.find((t) => t.event === e && t.from.includes(s as never))!.to;
    }
    expect(s).toBe('install_booked');
    expect(availableEvents(subscriptionMachine, 'install_booked', 'technician')).toEqual(['install_confirmed']);
  });
});

describe('tips and public issues', () => {
  it('lets the tipper withdraw only before a result', () => {
    expect(availableEvents(tipMachine, 'in_queue', 'tipper')).toContain('withdraw');
    expect(availableEvents(tipMachine, 'claim_review', 'tipper')).not.toContain('withdraw');
  });

  it('has an agency for every category except triage', () => {
    for (const c of tipCategories) if (c.code !== 'other') expect(c.agencyKinds.length, c.code).toBeGreaterThan(0);
    for (const c of issueCategories) expect(c.subtypes.length, c.code).toBeGreaterThan(1);
  });

  it('spots urgent words without flagging everyday ones', () => {
    expect(soundsUrgent('They are kidnapped right now')).toBe(true);
    expect(soundsUrgent('A pharmacy on Allen sells expired syrup')).toBe(false);
  });

  it('asks reporters to confirm a fix, and lets them reopen it', () => {
    expect(availableEvents(issueMachine, 'awaiting_check', 'citizen').sort()).toEqual(['confirm_fixed', 'not_fixed']);
    expect(issueStatus('awaiting_check', 'FERMA').title).toBe('Is it fixed?');
    expect(tipStatus('in_queue', 'NAPTIP').chip).toBe('With NAPTIP');
  });
});

describe('what each agency handles', () => {
  it('shows only the menus an agency kind can use', () => {
    expect(agencyHandles('naptip')).toMatchObject({ bounties: true, issues: false });
    expect(agencyHandles('roads')).toMatchObject({ tips: false, bounties: false, issues: true });
    expect(agencyHandles('police')).toMatchObject({ bounties: true, issues: true });
    expect(agencyHandles('fire')).toMatchObject({ tips: false, bounties: false, issues: false });
    // A health agency gets virus outbreak tips, but they pay no bounty.
    expect(agencyHandles('health')).toMatchObject({ tips: true, bounties: false });
  });
});

describe('bounty rates', () => {
  const naira = (k: number) => `₦${(k / 100).toLocaleString('en-NG')}`;
  it('suggests by basis and never above the cap', () => {
    const tiered = { basis: 'tiered' as const, tiers: { min: 5_000_000, max: 50_000_000 }, capKobo: 30_000_000 };
    expect(suggestBounty(tiered, { severity: 'standard' })).toBe(5_000_000);
    expect(suggestBounty(tiered, { severity: 'high' })).toBe(30_000_000);
    const pct = { basis: 'percent_capped' as const, tiers: { percent: 5 }, capKobo: 100_000_000 };
    expect(suggestBounty(pct, { severity: 'standard', recoveredKobo: 400_000_000 })).toBe(20_000_000);
    expect(suggestBounty(pct, { severity: 'standard', recoveredKobo: 10_000_000_000 })).toBe(100_000_000);
    expect(suggestBounty(null, { severity: 'high' })).toBe(0);
  });
  it('describes the range to tippers', () => {
    expect(bountyRangeText({ basis: 'percent_capped', tiers: { percent: 5 }, capKobo: 100_000_000 }, naira)).toBe('5% of the value recovered, up to ₦1,000,000');
    expect(bountyRangeText({ basis: 'fixed', tiers: { min: 2_000_000, max: 2_000_000 }, capKobo: null }, naira)).toBe('₦20,000');
  });
});

describe('payout fees', () => {
  it('uses Paystack transfer tiers', () => {
    expect(transferFee(500_000)).toBe(1_000);
    expect(transferFee(500_100)).toBe(2_500);
    expect(transferFee(100_000_000)).toBe(5_000);
  });
});

describe('platform fee on bounties', () => {
  const s = { suggestedBps: 1000, minBps: 500, maxBps: 2000 };
  it('uses the agency choice inside the range, else the suggestion', () => {
    expect(effectiveFeeBps(s, null)).toBe(1000);
    expect(effectiveFeeBps(s, 700)).toBe(700);
    expect(effectiveFeeBps(s, 100)).toBe(500); // range raised after the agency chose
    expect(effectiveFeeBps(s, 9000)).toBe(2000);
    expect(bountyFee(10_000_000, 1000)).toBe(1_000_000);
    expect(percent(750)).toBe('7.5%');
  });
  it('validates admin settings', () => {
    expect(checkFeeSettings(s)).toEqual({ ok: true });
    expect(checkFeeSettings({ ...s, suggestedBps: 3000 })).toMatchObject({ ok: false, field: 'suggestedBps' });
    expect(checkFeeSettings({ ...s, minBps: 2500 })).toMatchObject({ ok: false, field: 'maxBps' });
  });
});

describe('learn', () => {
  it('ranks For you by interests and watching, and hides muted topics', () => {
    const me = { interests: ['first_aid'], languages: ['en'], watchedTopics: { fire_safety: 2 }, mutedTopics: ['scams_fraud'], now: Date.UTC(2026, 9, 18) };
    const post = (topic: string, extra = {}) => ({ topic, language: 'en', publishedAt: Date.UTC(2026, 9, 17), seen: false, liked: false, ...extra });
    expect(rankForYou(post('fire_safety'), me).reason).toBe('Shown because you watch Fire safety');
    expect(rankForYou(post('first_aid'), me).reason).toBe('Because you picked First aid');
    expect(rankForYou(post('scams_fraud'), me).score).toBe(-Infinity);
    expect(rankForYou(post('fire_safety', { seen: true }), me).score).toBeLessThan(rankForYou(post('road_safety'), me).score);
    expect(rankForYou(post('first_aid', { language: 'ha' }), me).score).toBeLessThan(rankForYou(post('first_aid'), me).score);
  });

  it('checks a post is complete before review', () => {
    const base = { title: 'What to do first in a house fire', caption: 'Get low, get out, call from outside.', topic: 'fire_safety', hasMedia: false };
    expect(checkLearnPost({ ...base, format: 'video' })).toMatchObject({ field: 'media' });
    expect(checkLearnPost({ ...base, format: 'quiz', quiz: [{ q: 'Where do you call from?', options: ['Inside', 'Outside'], answer: 1, why: 'Smoke kills.' }] })).toBeNull();
    expect(checkLearnPost({ ...base, format: 'quiz', quiz: [{ q: 'Where?', options: ['Inside'], answer: 0, why: '' }] })).toMatchObject({ field: 'quiz' });
    expect(availableEvents(learnPostMachine, 'in_review', 'platform_admin').sort()).toEqual(['approve', 'remove', 'send_back']);
  });
});

describe('officer sub-ratings', () => {
  it('moves each sub-score with good and bad tags', () => {
    const r = subRatings([
      { stars: 4, tags: ['fast', 'polite'] },
      { stars: 5, tags: ['fast', 'clear'] },
      { stars: 3, tags: ['slow', 'unclear'] },
    ]);
    expect(r).toMatchObject({ overall: 4, count: 3, arrival: 4.2, care: 4.2, communication: 4 });
    expect(subRatings([])).toMatchObject({ overall: null, count: 0 });
  });
});

describe('withdrawal rules', () => {
  it('checks NUBAN and PIN strength', () => {
    expect(isNuban('0123456789')).toBe(true);
    expect(isNuban('12345')).toBe(false);
    expect(checkPin('1234')).toBe('Avoid digits in a row, like 1234.');
    expect(checkPin('7777')).toBe('Avoid the same digit four times.');
    expect(checkPin('12a4')).toBe('Use 4 digits.');
    expect(checkPin('4821')).toBeNull();
    expect(bankName('058')).toBe('GTBank');
  });
});
