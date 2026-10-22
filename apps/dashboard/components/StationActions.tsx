'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@erp/web-ui/api';
import { CloseReportSheet, ErrorBox, focusFirstError, useSubmit } from '@erp/web-ui/CloseReportSheet';
import { Sheet } from '@erp/web-ui/Sheet';

type Kind = 'assign' | 'transfer' | 'reassign' | 'close';

interface Officer {
  id: string;
  name: string;
  badgeNo: string;
  onDuty: boolean;
  badgeVerified: boolean;
  currentTask: string | null;
  distanceM: number | null;
  available: boolean;
}
interface Station {
  id: string;
  name: string;
  agency: string;
}

const TRANSFER_REASONS = ['Needs another service', 'Outside our area', 'Needs a specialist unit', 'Other'];
const REASSIGN_REASONS = ['Officer cannot reach', 'Officer needed elsewhere', 'Wrong unit for this report', 'Other'];
const DIRECT_REASONS = ['Nobody accepted in time', 'Nearest free officer', 'Knows the area', 'Needs this officer’s skills', 'Other'];

const distance = (m: number | null) => (m == null ? '' : m < 1000 ? `${m} m away` : `${(m / 1000).toFixed(1)} km away`);

/** Station action sheets — Assign unit, Transfer, Reassign, Close report (Gap Analysis S-1). */
export function StationActions({
  incidentId,
  state,
  actions,
  canDirectAssign,
  onDone,
}: {
  incidentId: string;
  state: string;
  actions: string[];
  /** The report has stalled, so an officer can be sent without having to accept. */
  canDirectAssign: boolean;
  onDone: (msg: string) => void;
}) {
  const [open, setOpen] = useState<Kind | null>(null);
  const can = {
    assign: actions.includes('assign'),
    reassign: actions.includes('reassign') || actions.includes('officer_drop'),
    transfer: actions.includes('transfer'),
    close: actions.includes('begin_close') || actions.includes('close_valid'),
  };
  const close = useCallback(() => setOpen(null), []);
  const done = (msg: string) => {
    setOpen(null);
    onDone(msg);
  };

  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        {can.assign && (
          <button className="btn signal" type="button" onClick={() => setOpen('assign')}>
            {state === 'offered' ? 'Offer to someone else' : 'Assign unit'}
          </button>
        )}
        {can.reassign && (
          <button className="btn" type="button" onClick={() => setOpen('reassign')}>
            Reassign
          </button>
        )}
        {can.transfer && (
          <button className="btn" type="button" onClick={() => setOpen('transfer')}>
            Transfer
          </button>
        )}
        {can.close && (
          <button className="btn" type="button" onClick={() => setOpen('close')}>
            Close report
          </button>
        )}
        {!can.assign && !can.reassign && !can.transfer && !can.close && (
          <span style={{ color: 'var(--color-text-secondary)', fontSize: 14 }}>No station actions at this stage.</span>
        )}
      </div>
      {open === 'assign' && <AssignSheet incidentId={incidentId} canDirect={canDirectAssign} onClose={close} onDone={done} />}
      {open === 'transfer' && <TransferSheet incidentId={incidentId} onClose={close} onDone={done} />}
      {open === 'reassign' && <ReassignSheet incidentId={incidentId} canChoose={actions.includes('reassign')} onClose={close} onDone={done} />}
      {open === 'close' && <CloseReportSheet incidentId={incidentId} state={state} onClose={close} onDone={done} />}
    </>
  );
}

interface SheetProps {
  incidentId: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}




/** Officers at the station, nearest first; only free ones can be picked. */
function useOfficers(incidentId: string, onError: (m: string) => void) {
  const [officers, setOfficers] = useState<Officer[] | null>(null);
  const [pick, setPick] = useState('');
  useEffect(() => {
    api<Officer[]>(`/me/station/officers?near=${incidentId}`)
      .then((o) => {
        setOfficers(o);
        setPick(o.find((x) => x.available)?.id ?? '');
      })
      .catch((e: ApiError) => onError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId]);
  return { officers, pick, setPick, chosen: officers?.find((o) => o.id === pick) };
}

function OfficerPicker({ officers, pick, setPick }: { officers: Officer[] | null; pick: string; setPick: (id: string) => void }) {
  return (
    <>
      {officers === null && [0, 1].map((i) => <div key={i} className="skeleton" />)}
      {officers?.length === 0 && <p className="sheet-desc">No officers yet. Invite officers to start receiving reports.</p>}
      <div role="radiogroup" aria-label="Officers" style={{ display: 'grid', gap: 8 }}>
        {officers?.map((o) => {
          const why = !o.onDuty ? 'Off duty' : !o.badgeVerified ? 'Badge not verified' : o.currentTask ? `On ${o.currentTask}` : distance(o.distanceM) || 'Available';
          return (
            <label key={o.id} className="choice">
              <input type="radio" name="officer" value={o.id} aria-label={`${o.name}, ${why}`} checked={pick === o.id} disabled={!o.available} onChange={() => setPick(o.id)} />
              <span className="meta">
                <strong>{o.name}</strong>
                <span>
                  Badge {o.badgeNo} · {why}
                </span>
              </span>
              {o.available ? <span className="chip success">Free</span> : <span className="chip neutral">Busy</span>}
            </label>
          );
        })}
      </div>
    </>
  );
}

/**
 * Assign unit. "Offer" sends the offer to the officer chosen (in place of one still running); they
 * have to accept in time. "Send now" puts them on it at once, with a reason, and is open only once
 * the report has stalled. The officer can answer that they can't go.
 */
function AssignSheet({ incidentId, canDirect, onClose, onDone }: SheetProps & { canDirect: boolean }) {
  const s = useSubmit();
  const { officers, pick, setPick, chosen } = useOfficers(incidentId, s.setError);
  const [mode, setMode] = useState<'offer' | 'direct'>(canDirect ? 'direct' : 'offer');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const fullReason = reason === 'Other' ? note.trim() : [reason, note.trim()].filter(Boolean).join('. ');
  const needsReason = mode === 'direct' && !fullReason;
  return (
    <Sheet
      open
      title="Assign unit"
      description={mode === 'direct' ? 'The officer is on the report at once and is told your reason. They can say they can’t go.' : 'The officer gets the offer and has to accept it in time. Any offer still running is withdrawn and not held against that officer.'}
      onClose={onClose}
      busy={s.busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={s.busy}>
            Cancel
          </button>
          <button
            className="btn signal"
            type="button"
            disabled={!chosen || s.busy}
            onClick={() => {
              setTried(true);
              if (needsReason) return focusFirstError();
              void s.run(async () => {
                const r = await api<{ message: string }>(`/incidents/${incidentId}/assign`, { method: 'POST', body: JSON.stringify({ officerId: pick, mode, reason: fullReason || undefined }) });
                onDone(r.message);
              });
            }}
          >
            {s.busy ? 'Sending…' : !chosen ? 'Choose an officer' : mode === 'direct' ? `Send ${chosen.name} now` : `Offer to ${chosen.name}`}
          </button>
        </>
      }
    >
      <ErrorBox error={s.error} />
      <div className="segmented" role="radiogroup" aria-label="How to assign">
        <button type="button" role="radio" aria-checked={mode === 'offer'} aria-pressed={mode === 'offer'} onClick={() => setMode('offer')}>
          Offer, they accept
        </button>
        <button type="button" role="radio" aria-checked={mode === 'direct'} aria-pressed={mode === 'direct'} disabled={!canDirect} onClick={() => setMode('direct')}>
          Send now
        </button>
      </div>
      {!canDirect && <p className="sheet-desc">Send now opens when nobody has taken the report: an offer ran out or was declined, or it has waited too long.</p>}
      <OfficerPicker officers={officers} pick={pick} setPick={setPick} />
      <div className="field" data-invalid={tried && needsReason}>
        <span>{mode === 'direct' ? 'Why this officer' : 'Note for the officer (optional)'}</span>
        <ReasonChips label="Reason" options={DIRECT_REASONS} value={reason} onChange={setReason} />
        <textarea placeholder="Add detail (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={250} aria-label="Detail" />
        {tried && needsReason && <span className="field-error">Say why you are sending this officer.</span>}
      </div>
    </Sheet>
  );
}

function ReasonChips({ options, value, onChange, label }: { options: string[]; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o} type="button" aria-pressed={value === o} onClick={() => onChange(o)}>
          {o}
        </button>
      ))}
    </div>
  );
}

function TransferSheet({ incidentId, onClose, onDone }: SheetProps) {
  const [stations, setStations] = useState<Station[] | null>(null);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const s = useSubmit();

  useEffect(() => {
    api<Station[]>('/me/station/transfer-targets')
      .then(setStations)
      .catch((e: ApiError) => s.setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const station = stations?.find((x) => x.id === target);
  const fullReason = reason === 'Other' ? note.trim() : [reason, note.trim()].filter(Boolean).join('. ');
  const invalid = { target: !target, reason: !fullReason };

  return (
    <Sheet
      open
      title="Transfer report"
      description="The report moves to the other station. Your units on it are released."
      onClose={onClose}
      busy={s.busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={s.busy}>
            Cancel
          </button>
          <button
            className="btn signal"
            type="button"
            disabled={s.busy}
            onClick={() => {
              setTried(true);
              if (invalid.target || invalid.reason) return focusFirstError();
              void s.run(async () => {
                await api(`/incidents/${incidentId}/actions`, { method: 'POST', body: JSON.stringify({ event: 'transfer', targetStationId: target, reason: fullReason }) });
                onDone(`Transferred to ${station!.name}.`);
              });
            }}
          >
            {s.busy ? 'Transferring…' : station ? `Transfer to ${station.name}` : 'Transfer'}
          </button>
        </>
      }
    >
      <ErrorBox error={s.error} />
      <label className="field" data-invalid={tried && invalid.target}>
        <span>Station</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)} aria-invalid={tried && invalid.target}>
          <option value="">{stations === null ? 'Loading…' : stations.length ? 'Choose a station' : 'No other stations available'}</option>
          {stations?.map((st) => (
            <option key={st.id} value={st.id}>
              {st.name} — {st.agency}
            </option>
          ))}
        </select>
        {tried && invalid.target && <span className="field-error">Choose a station.</span>}
      </label>
      <div className="field" data-invalid={tried && invalid.reason}>
        <span>Why</span>
        <ReasonChips label="Transfer reason" options={TRANSFER_REASONS} value={reason} onChange={setReason} />
        <textarea placeholder="Add a note for the next station (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={400} aria-label="Note" />
        {tried && invalid.reason && <span className="field-error">Say why you are transferring.</span>}
      </div>
    </Sheet>
  );
}

/**
 * Reassign. "Choose the officer" moves the report straight to the officer picked; "Next free officer"
 * takes the current one off and offers it on as usual. A reason is needed either way.
 */
function ReassignSheet({ incidentId, canChoose, onClose, onDone }: SheetProps & { canChoose: boolean }) {
  const s = useSubmit();
  const { officers, pick, setPick, chosen } = useOfficers(incidentId, s.setError);
  const [mode, setMode] = useState<'choose' | 'next'>(canChoose ? 'choose' : 'next');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const fullReason = reason === 'Other' ? note.trim() : [reason, note.trim()].filter(Boolean).join('. ');
  return (
    <Sheet
      open
      title="Reassign report"
      description={
        mode === 'choose'
          ? 'The current officer is taken off and told why. The officer you choose is on it at once and can say they can’t go. The reporter is told a new officer is coming.'
          : 'The current officer is taken off. The report is offered to the next free officer, and the reporter is told a new team is coming.'
      }
      onClose={onClose}
      busy={s.busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={s.busy}>
            Keep officer
          </button>
          <button
            className="btn signal"
            type="button"
            disabled={s.busy || (mode === 'choose' && !chosen)}
            onClick={() => {
              setTried(true);
              if (!fullReason) return focusFirstError();
              void s.run(async () => {
                if (mode === 'choose') {
                  onDone((await api<{ message: string }>(`/incidents/${incidentId}/reassign`, { method: 'POST', body: JSON.stringify({ officerId: pick, reason: fullReason }) })).message);
                } else {
                  await api(`/incidents/${incidentId}/actions`, { method: 'POST', body: JSON.stringify({ event: 'officer_drop', reason: fullReason }) });
                  onDone('Reassigning to the next free officer.');
                }
              });
            }}
          >
            {s.busy ? 'Reassigning…' : mode === 'choose' ? (chosen ? `Move to ${chosen.name}` : 'Choose an officer') : 'Reassign report'}
          </button>
        </>
      }
    >
      <ErrorBox error={s.error} />
      {canChoose && (
        <div className="segmented" role="radiogroup" aria-label="Who takes it">
          <button type="button" role="radio" aria-checked={mode === 'choose'} aria-pressed={mode === 'choose'} onClick={() => setMode('choose')}>
            Choose the officer
          </button>
          <button type="button" role="radio" aria-checked={mode === 'next'} aria-pressed={mode === 'next'} onClick={() => setMode('next')}>
            Next free officer
          </button>
        </div>
      )}
      {mode === 'choose' && <OfficerPicker officers={officers} pick={pick} setPick={setPick} />}
      <div className="field" data-invalid={tried && !fullReason}>
        <span>Why</span>
        <ReasonChips label="Reassign reason" options={REASSIGN_REASONS} value={reason} onChange={setReason} />
        <textarea placeholder="Add detail (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={250} aria-label="Detail" />
        {tried && !fullReason && <span className="field-error">A reason is required.</span>}
      </div>
    </Sheet>
  );
}
