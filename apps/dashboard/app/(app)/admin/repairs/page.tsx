'use client';
// Board "Admin device ticket" (B5): confirm the fault, book a technician and a time window,
// then mark fixed; the owner confirms it works, which closes the ticket.
import { api, ApiError } from '@erp/web-ui/api';
import { ErrorBox, focusFirstError, useSubmit } from '@erp/web-ui/CloseReportSheet';
import { Sheet } from '@erp/web-ui/Sheet';
import { useCallback, useEffect, useState } from 'react';
import { dateTime, useToast } from '@/components/Agency';
import { LocationFilter, locQuery, type LocFilter } from '@/components/LocationFilter';

interface Ticket {
  id: string;
  number: string;
  device: string;
  deviceStatus: string;
  problem: string;
  description: string;
  bestTime: string | null;
  urgent: boolean;
  covered: boolean;
  owner: string;
  address: string;
  visit: string | null;
  technician: string | null;
  step: 'received' | 'confirmed' | 'booked' | 'fixed' | 'closed';
  at: string;
}
const STEP: Record<Ticket['step'], [string, string]> = {
  received: ['New', 'warning'],
  confirmed: ['Fault confirmed', 'info'],
  booked: ['Visit booked', 'info'],
  fixed: ['Waiting for owner', 'neutral'],
  closed: ['Closed', 'success'],
};
const WINDOWS = ['9am to 12pm', '12pm to 3pm', '3pm to 6pm'];

export default function RepairsAdmin() {
  const [d, setD] = useState<{ technicians: { id: string; name: string }[]; items: Ticket[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Ticket | null>(null);
  const [toast, setToast] = useToast();
  const [loc, setLoc] = useState<LocFilter>({});
  const lq = locQuery(loc);
  const load = useCallback(() => {
    api<{ technicians: { id: string; name: string }[]; items: Ticket[] }>(`/admin/repairs${lq ? `?${lq}` : ''}`)
      .then(setD)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load repairs.'));
  }, [lq]);
  useEffect(() => {
    load();
  }, [load]);
  const count = (s: Ticket['step'][]) => d?.items.filter((x) => s.includes(x.step)).length ?? '—';

  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>Installation team</h1>
          <p className="lede">New installs paid for by households, and faults owners report. Damage is urgent and the local station is told.</p>
        </div>
      </div>
      <LocationFilter value={loc} onChange={setLoc} />
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div className="stats">
        <div className="stat">
          <span>To check</span>
          <strong className="warning">{count(['received', 'confirmed'])}</strong>
          <small>Confirm and book a visit</small>
        </div>
        <div className="stat">
          <span>Visits booked</span>
          <strong>{count(['booked'])}</strong>
          <small>Mark fixed after the visit</small>
        </div>
        <div className="stat">
          <span>Urgent</span>
          <strong className="critical">{d ? d.items.filter((x) => x.urgent && x.step !== 'closed').length : '—'}</strong>
          <small>Damaged or moved</small>
        </div>
      </div>
      <Installs technicians={d?.technicians ?? []} onToast={setToast} lq={lq} />
      <h2 style={{ margin: '24px 0 8px' }}>Repairs</h2>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {!d && !error ? (
          <div style={{ padding: 20 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" />
            ))}
          </div>
        ) : !d?.items.length ? (
          <div className="empty">
            <strong>No repairs.</strong>
            Owners report problems from My home devices.
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Ticket</th>
                <th>Device and problem</th>
                <th>Home</th>
                <th>Visit</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((t) => (
                <tr key={t.id} className="link" onClick={() => setOpen(t)}>
                  <td>
                    <button type="button" className="link-btn" style={{ fontWeight: 700, color: 'inherit' }} onClick={(e) => (e.stopPropagation(), setOpen(t))}>
                      {t.number}
                    </button>
                    <div className="muted">{dateTime(t.at)}</div>
                  </td>
                  <td>
                    {t.urgent && <span className="chip critical" style={{ marginRight: 6 }}>Urgent</span>}
                    <strong>{t.device}</strong>: {t.problem}
                  </td>
                  <td>
                    {t.owner}
                    <div className="muted">{t.address}</div>
                  </td>
                  <td>{t.visit ? `${t.visit}${t.technician ? `, ${t.technician}` : ''}` : <span className="muted">{t.bestTime ? `Asked: ${t.bestTime}` : 'Not booked'}</span>}</td>
                  <td>
                    <span className={`chip ${STEP[t.step][1]}`}>{STEP[t.step][0]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {open && d && (
        <TicketSheet
          t={open}
          technicians={d.technicians}
          onClose={() => setOpen(null)}
          onDone={(m) => {
            setOpen(null);
            setToast(m);
            load();
          }}
        />
      )}
    </>
  );
}

function TicketSheet({ t, technicians, onClose, onDone }: { t: Ticket; technicians: { id: string; name: string }[]; onClose: () => void; onDone: (m: string) => void }) {
  const [booking, setBooking] = useState(false);
  const [date, setDate] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  const [win, setWin] = useState(WINDOWS[0]!);
  const [tech, setTech] = useState(technicians[0]?.id ?? '');
  const [tried, setTried] = useState(false);
  const s = useSubmit();
  const act = (action: string, extra: object = {}) =>
    s.run(async () => {
      const r = await api<{ message: string }>(`/admin/repairs/${t.id}`, { method: 'POST', body: JSON.stringify({ action, ...extra }) });
      onDone(`${t.number}: ${r.message}`);
    });
  const book = () => {
    setTried(true);
    if (!date) return focusFirstError();
    void act('book', { scheduledAt: new Date(`${date}T09:00:00+01:00`).toISOString(), window: win, technicianId: tech || undefined });
  };
  const footer =
    t.step === 'closed' || t.step === 'fixed' ? (
      <button className="btn" type="button" onClick={onClose}>
        Close
      </button>
    ) : booking ? (
      <>
        <button className="btn" type="button" onClick={() => setBooking(false)} disabled={s.busy}>
          Back
        </button>
        <button className="btn primary" type="button" onClick={book} disabled={s.busy}>
          {s.busy ? 'Booking…' : 'Book visit'}
        </button>
      </>
    ) : (
      <>
        {t.step === 'received' && (
          <button className="btn" type="button" onClick={() => void act('confirm_fault')} disabled={s.busy}>
            Confirm fault
          </button>
        )}
        <button className={`btn ${t.step === 'booked' ? '' : 'primary'}`} type="button" onClick={() => setBooking(true)} disabled={s.busy}>
          {t.step === 'booked' ? 'Rebook' : 'Book visit'}
        </button>
        {t.step === 'booked' && (
          <button className="btn primary" type="button" onClick={() => void act('fixed')} disabled={s.busy}>
            {s.busy ? 'Saving…' : 'Mark fixed'}
          </button>
        )}
      </>
    );
  return (
    <Sheet open title={`Repair ${t.number}`} description={`${t.owner}, ${t.address}`} onClose={onClose} busy={s.busy} footer={footer}>
      <ErrorBox error={s.error} />
      {booking ? (
        <>
          <label className="field" data-invalid={tried && !date}>
            <span>Date</span>
            <input type="date" value={date} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} aria-invalid={tried && !date} />
          </label>
          <label className="field">
            <span>Time window</span>
            <select value={win} onChange={(e) => setWin(e.target.value)}>
              {WINDOWS.map((w) => (
                <option key={w}>{w}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Technician</span>
            <select value={tech} onChange={(e) => setTech(e.target.value)}>
              {technicians.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          {t.bestTime && <p className="muted">The owner asked for: {t.bestTime}.</p>}
        </>
      ) : (
        <dl className="facts">
          <div>
            <dt>Device</dt>
            <dd>
              {t.device} ({t.deviceStatus.replace('_', ' ')})
            </dd>
          </div>
          <div>
            <dt>Problem</dt>
            <dd>
              {t.problem}
              {t.urgent ? ', urgent' : ''}
            </dd>
          </div>
          <div>
            <dt>Owner says</dt>
            <dd>{t.description}</dd>
          </div>
          <div>
            <dt>Best time</dt>
            <dd>{t.bestTime ?? 'Any time'}</dd>
          </div>
          <div>
            <dt>Visit</dt>
            <dd>{t.visit ? `${t.visit}, ${t.technician}` : 'Not booked'}</dd>
          </div>
          <div>
            <dt>Cost</dt>
            <dd>{t.covered ? 'Covered by the plan' : 'Not covered: send a quote'}</dd>
          </div>
        </dl>
      )}
    </Sheet>
  );
}

interface Install {
  id: string;
  number: string;
  state: string;
  plan: string;
  devices: { camera?: number; street_light?: number };
  owner: string;
  address: string;
  visit: string | null;
  technician: string | null;
  at: string;
}

/** New installs (board "Admin install job"): book the visit, then mark installed; the plan starts then. */
function Installs({ technicians, onToast, lq }: { technicians: { id: string; name: string }[]; onToast: (m: string) => void; lq: string }) {
  const [list, setList] = useState<Install[] | null>(null);
  const [booking, setBooking] = useState<Install | null>(null);
  const [date, setDate] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  const [win, setWin] = useState(WINDOWS[0]!);
  const s = useSubmit();
  const load = useCallback(() => {
    api<Install[]>(`/admin/installs${lq ? `?${lq}` : ''}`).then(setList).catch(() => setList([]));
  }, [lq]);
  useEffect(load, [load]);
  const act = (j: Install, body: object) =>
    s.run(async () => {
      const r = await api<{ message: string }>(`/admin/installs/${j.id}`, { method: 'POST', body: JSON.stringify(body) });
      onToast(`${j.number}: ${r.message}`);
      setBooking(null);
      load();
    });
  return (
    <section className="card" aria-labelledby="inst">
      <h2 id="inst">Installs</h2>
      <ErrorBox error={s.error} />
      {!list && <div className="skeleton" />}
      {list?.length === 0 && <p className="muted">No installs waiting. They appear when a household pays for a plan.</p>}
      {list?.map((j) => (
        <div className="row" key={j.id}>
          <div className="label">
            <strong>
              {j.number}, {j.plan} for {j.owner}
            </strong>
            <span>
              {j.address} · {[j.devices.camera && `${j.devices.camera} camera`, j.devices.street_light && `${j.devices.street_light} light`].filter(Boolean).join(', ')}
              {j.visit ? ` · ${j.visit}${j.technician ? `, ${j.technician}` : ''}` : ''}
            </span>
          </div>
          {j.state === 'done' ? (
            <span className="chip success">Installed</span>
          ) : j.state === 'scheduled' ? (
            <button className="btn primary" type="button" disabled={s.busy} onClick={() => void act(j, { action: 'installed' })}>
              Mark installed
            </button>
          ) : (
            <button className="btn" type="button" onClick={() => setBooking(j)}>
              Book visit
            </button>
          )}
        </div>
      ))}
      {booking && (
        <Sheet
          open
          title={`Book install ${booking.number}`}
          description={`${booking.owner}, ${booking.address}`}
          onClose={() => setBooking(null)}
          busy={s.busy}
          footer={
            <>
              <button className="btn" type="button" onClick={() => setBooking(null)}>
                Cancel
              </button>
              <button className="btn primary" type="button" disabled={s.busy} onClick={() => void act(booking, { action: 'book', scheduledAt: new Date(`${date}T09:00:00+01:00`).toISOString(), window: win, technicianId: technicians[0]?.id })}>
                Book visit
              </button>
            </>
          }
        >
          <label className="field">
            <span>Date</span>
            <input type="date" value={date} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            <span>Time window</span>
            <select value={win} onChange={(e) => setWin(e.target.value)}>
              {WINDOWS.map((w) => (
                <option key={w}>{w}</option>
              ))}
            </select>
          </label>
        </Sheet>
      )}
    </section>
  );
}
