'use client';

import Link from 'next/link';
import { use, useCallback, useState } from 'react';
import { api } from '@erp/web-ui/api';
import { ErrorBox, focusFirstError, useSubmit } from '@erp/web-ui/CloseReportSheet';
import { Sheet } from '@erp/web-ui/Sheet';
import { Evidence } from '@/components/Evidence';
import { WithAgency, dateTime, plural, shortDate, useAgencyRecord, useToast } from '@/components/Agency';
import { CONTEXT, STOLEN_TONE } from '@/components/StolenItems';

type Event = 'investigate' | 'locate' | 'recover' | 'return_to_owner' | 'close';
interface Match {
  id: string;
  checkNo: string;
  context: string;
  at: string;
  checker: string;
  checkerPhone: string | null;
  place: string;
  area: string | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  ourCase: boolean;
  reviewed: boolean;
  sellerDetails: Array<{ sellerName: string | null; sellerPhone: string | null; note: string | null; at: string }>;
}
interface CaseView {
  id: string;
  publicNo: string;
  state: string;
  stateLabel: string;
  ours: boolean;
  agency: string;
  station: string | null;
  item: { id: string; name: string; typeLabel: string; identifierLabel: string; identifier: string; make: string | null; model: string | null; colour: string | null; description: string | null; registeredBefore: boolean; registeredAt: string | null };
  owner: { name: string; phone: string | null } | null;
  stolenOn: string;
  circumstances: string | null;
  policeReportNo: string | null;
  place: string;
  area: string | null;
  ownershipConflict: boolean;
  alsoRegisteredBy: Array<{ name: string; since: string }>;
  documents: Array<{ code: string; label: string; required: boolean; provided: boolean }>;
  proofComplete: boolean;
  matches: Match[];
  actions: Event[];
  history: Array<{ kind: string; label: string; by: string; note: string | null; at: string }>;
  createdAt: string;
}

const ACTION: Record<Event, { label: string; title: string; description: string; done: string; note: string; required?: string }> = {
  investigate: { label: 'Start investigating', title: 'Start investigating', description: 'The owner is told the police are on it.', done: 'Investigation started. The owner was told.', note: 'Note (optional)' },
  locate: { label: 'Mark located', title: 'Item located', description: 'You know where the item is. The owner is told you are working to recover it.', done: 'Marked located. The owner was told.', note: 'Where it is (optional, not shown to the owner)' },
  recover: { label: 'Mark recovered', title: 'Item recovered', description: 'Buyers checking it are no longer warned. The owner is asked to bring their proof.', done: 'Recovered. The owner was told.', note: 'Where and how it was recovered', required: 'Say where and how it was recovered.' },
  return_to_owner: { label: 'Returned to owner', title: 'Returned to the owner', description: 'Check the owner’s proof of ownership before handing it over. This closes the case.', done: 'Returned. Case closed.', note: 'Note (optional)' },
  close: { label: 'Close, not recovered', title: 'Close without recovery', description: 'The item stays on the stolen list, so buyers are still warned.', done: 'Case closed.', note: 'Why the case is closed', required: 'Say why the case is closed.' },
};
const ORDER: Event[] = ['investigate', 'locate', 'recover', 'return_to_owner', 'close'];

/** One stolen-item case for the police: the item, the owner, buyer-check matches and the recovery. */
export default function StolenCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <WithAgency needs="stolen">{() => <StolenCase id={id} />}</WithAgency>;
}

function StolenCase({ id }: { id: string }) {
  const { data: v, error, agencyId, reload } = useAgencyRecord<CaseView>((a) => `/agencies/${a}/stolen/${id}`);
  const [open, setOpen] = useState<Event | null>(null);
  const [review, setReview] = useState<{ match: Match; outcome: 'followed_up' | 'dismissed' } | null>(null);
  const [toast, setToast] = useToast();
  const close = useCallback(() => (setOpen(null), setReview(null)), []);
  const done = (msg: string) => {
    close();
    setToast(msg);
    reload();
  };

  if (error)
    return (
      <div className="card empty">
        <strong>{error.status === 404 ? 'This case is not with your agency.' : 'Could not load this case'}</strong>
        {error.status !== 404 && <span>{error.message}</span>}
        <Link href="/agency/stolen">Back to stolen items</Link>
      </div>
    );
  if (!v || !agencyId)
    return (
      <>
        <div className="skeleton" style={{ height: 40, width: 320 }} />
        <div className="skeleton" style={{ height: 200 }} />
      </>
    );

  const base = `/agencies/${agencyId}/stolen/${v.id}`;
  const fresh = v.matches.filter((m) => !m.reviewed).length;
  const docLabels = Object.fromEntries(v.documents.map((d) => [d.code, d.label]));
  return (
    <>
      <p style={{ margin: '0 0 8px' }}>
        <Link href="/agency/stolen">← Stolen items</Link>
      </p>
      <div className="page-head">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h1>{v.item.name}</h1>
            <span className={`chip ${STOLEN_TONE[v.state] ?? 'neutral'}`}>{v.stateLabel}</span>
          </div>
          <p className="lede">
            {v.item.typeLabel} stolen {shortDate(v.stolenOn)} at {v.place}
            {v.area ? `, ${v.area}` : ''}. Case {v.publicNo}
            {v.station ? `, ${v.station}` : ''}.
          </p>
        </div>
      </div>

      {!v.ours && (
        <div className="banner info">
          <strong>{v.agency} holds this case</strong>A buyer check on it was made in your area. You see the matches; the owner’s contact stays with {v.agency}.
        </div>
      )}
      {v.ownershipConflict && v.ours && (
        <div className="banner warning">
          <strong>Ownership disputed</strong>
          This {v.item.identifierLabel} is also registered to {v.alsoRegisteredBy.map((o) => `${o.name} (since ${shortDate(o.since)})`).join(', ') || 'someone else'}. Check both proofs of ownership before returning it.
        </div>
      )}

      <div className="stats">
        <div className="stat">
          <span>Buyer checks</span>
          <strong className={fresh ? 'critical' : undefined}>{v.matches.length}</strong>
          <small>{fresh ? `${plural(fresh, 'not reviewed', 'not reviewed')}` : v.matches.length ? 'All reviewed' : 'None yet'}</small>
        </div>
        <div className="stat">
          <span>Proof of ownership</span>
          <strong className={v.proofComplete ? 'success' : 'warning'}>{v.proofComplete ? 'Provided' : 'Missing'}</strong>
          <small>{v.documents.filter((d) => d.provided).map((d) => d.label).join(', ') || 'No documents yet'}</small>
        </div>
        <div className="stat">
          <span>Registered</span>
          <strong>{v.item.registeredBefore ? 'Before theft' : 'At report'}</strong>
          <small>{v.item.registeredAt ? `Since ${shortDate(v.item.registeredAt)}` : 'Added with the stolen report'}</small>
        </div>
        <div className="stat">
          <span>Reported</span>
          <strong>{shortDate(v.createdAt)}</strong>
          <small>{v.policeReportNo ? `Station report ${v.policeReportNo}` : 'No station report number'}</small>
        </div>
      </div>

      <section className="card" aria-labelledby="matches" id="matches">
        <h2 id="matches">Buyer-check matches</h2>
        {!v.matches.length && <p className="muted">Nobody has checked this item yet. If someone does before buying, you are told at once with where.</p>}
        {v.matches.map((m) => (
          <article key={m.id} id={`match-${m.id}`} className="match" style={{ borderTop: '1px solid var(--color-border)', padding: '12px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
              <strong>
                {dateTime(m.at)} · {CONTEXT[m.context] ?? m.context}
              </strong>
              <span className={`chip ${m.reviewed ? 'neutral' : 'critical'}`}>{m.reviewed ? 'Reviewed' : 'New'}</span>
            </div>
            <dl className="facts" style={{ marginTop: 8 }}>
              <div>
                <dt>Where it was checked</dt>
                <dd>
                  {m.place}
                  {m.area ? `, ${m.area}` : ''}
                  {m.lat != null && m.lng != null && (
                    <>
                      {' '}
                      <a href={`https://www.openstreetmap.org/?mlat=${m.lat}&mlon=${m.lng}#map=18/${m.lat}/${m.lng}`} target="_blank" rel="noreferrer">
                        Map
                      </a>
                      {m.accuracyM ? ` (±${m.accuracyM} m)` : ''}
                    </>
                  )}
                </dd>
              </div>
              <div>
                <dt>Buyer</dt>
                <dd>
                  {m.checker}
                  {m.checkerPhone ? ` · ${m.checkerPhone}` : ''}
                </dd>
              </div>
              <div>
                <dt>Reference</dt>
                <dd>{m.checkNo}</dd>
              </div>
            </dl>
            {m.sellerDetails.map((d, i) => (
              <p key={i} className="quote">
                {[d.sellerName && `Seller: ${d.sellerName}`, d.sellerPhone && `Phone: ${d.sellerPhone}`, d.note].filter(Boolean).join(' · ')}
              </p>
            ))}
            {!m.reviewed && (
              <div className="actions">
                <button className="btn signal" type="button" onClick={() => setReview({ match: m, outcome: 'followed_up' })}>
                  Followed up
                </button>
                <button className="btn" type="button" onClick={() => setReview({ match: m, outcome: 'dismissed' })}>
                  Dismiss
                </button>
              </div>
            )}
          </article>
        ))}
        <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
          A buyer who checked and walked away did the right thing. Treat them as a witness, not a suspect.
        </p>
      </section>

      <div className="grid two">
        <section className="card" aria-labelledby="item">
          <h2 id="item">Item</h2>
          <dl className="facts">
            <div>
              <dt>{v.item.identifierLabel}</dt>
              <dd style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>{v.item.identifier}</dd>
            </div>
            {v.item.make && (
              <div>
                <dt>Make</dt>
                <dd>{v.item.make}</dd>
              </div>
            )}
            {v.item.model && (
              <div>
                <dt>Model</dt>
                <dd>{v.item.model}</dd>
              </div>
            )}
            {v.item.colour && (
              <div>
                <dt>Colour</dt>
                <dd>{v.item.colour}</dd>
              </div>
            )}
          </dl>
          {v.circumstances && <p className="quote">{v.circumstances}</p>}
          <Evidence ownerType="stolen_case" ownerId={v.id} label="sent with the report" docLabels={docLabels} />
          <Evidence ownerType="owned_item" ownerId={v.item.id} label="from the owner’s registry" docLabels={docLabels} />
        </section>

        <section className="card" aria-labelledby="owner">
          <h2 id="owner">Owner</h2>
          {v.owner ? (
            <dl className="facts">
              <div>
                <dt>Name</dt>
                <dd>{v.owner.name}</dd>
              </div>
              <div>
                <dt>Phone</dt>
                <dd>{v.owner.phone ?? 'Not given'}</dd>
              </div>
            </dl>
          ) : (
            <p className="muted">With {v.agency}.</p>
          )}
          <h3 style={{ fontSize: 14, margin: '16px 0 8px' }}>Proof of ownership</h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {v.documents.map((d) => (
              <li key={d.code}>
                {d.label}: <strong className={d.provided ? undefined : 'warning'}>{d.provided ? 'provided' : d.required ? 'missing' : 'not given'}</strong>
              </li>
            ))}
          </ul>
        </section>

        <section className="card" aria-labelledby="act">
          <h2 id="act">Recovery</h2>
          <div className="actions">
            {ORDER.filter((e) => v.actions.includes(e)).map((e, i) => (
              <button key={e} className={`btn ${i === 0 && e !== 'close' ? 'signal' : ''}`} type="button" onClick={() => setOpen(e)}>
                {ACTION[e].label}
              </button>
            ))}
            {!v.actions.length && <span className="muted">{v.ours ? 'This case is closed.' : `${v.agency} moves this case.`}</span>}
          </div>
        </section>

        <section className="card" aria-labelledby="hist">
          <h2 id="hist">History</h2>
          <ol className="timeline">
            {v.history.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <time dateTime={e.at}>{dateTime(e.at)}</time>
                <span>
                  {e.label} <span style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>· {e.by}</span>
                  {e.note && <span style={{ display: 'block', color: 'var(--color-text-secondary)', fontSize: 13 }}>{e.note}</span>}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {open && <ActSheet event={open} path={`${base}/actions`} onClose={close} onDone={done} />}
      {review && <ReviewSheet match={review.match} outcome={review.outcome} path={`${base}/matches/${review.match.id}/review`} onClose={close} onDone={done} />}
      {toast}
    </>
  );
}

function ActSheet({ event, path, onClose, onDone }: { event: Event; path: string; onClose: () => void; onDone: (m: string) => void }) {
  const a = ACTION[event];
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const s = useSubmit();
  const invalid = !!a.required && note.trim().length < 3;
  return (
    <Sheet
      open
      title={a.title}
      description={a.description}
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
              if (invalid) return focusFirstError();
              void s.run(async () => {
                await api(path, { method: 'POST', body: JSON.stringify({ event, note: note.trim() || undefined }) });
                onDone(a.done);
              });
            }}
          >
            {s.busy ? 'Saving…' : a.label}
          </button>
        </>
      }
    >
      <ErrorBox error={s.error} />
      <label className="field" data-invalid={tried && invalid}>
        <span>{a.note}</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} aria-invalid={tried && invalid} />
        {tried && invalid && <span className="field-error">{a.required}</span>}
      </label>
    </Sheet>
  );
}

function ReviewSheet({ match, outcome, path, onClose, onDone }: { match: Match; outcome: 'followed_up' | 'dismissed'; path: string; onClose: () => void; onDone: (m: string) => void }) {
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const s = useSubmit();
  const invalid = outcome === 'dismissed' && note.trim().length < 3;
  return (
    <Sheet
      open
      title={outcome === 'dismissed' ? 'Dismiss this match' : 'Mark followed up'}
      description={`Check ${match.checkNo} on ${dateTime(match.at)}${match.area ? ` near ${match.area}` : ''}.`}
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
              if (invalid) return focusFirstError();
              void s.run(async () => {
                await api(path, { method: 'POST', body: JSON.stringify({ outcome, note: note.trim() || undefined }) });
                onDone(outcome === 'dismissed' ? 'Match dismissed.' : 'Match marked followed up.');
              });
            }}
          >
            {s.busy ? 'Saving…' : outcome === 'dismissed' ? 'Dismiss' : 'Followed up'}
          </button>
        </>
      }
    >
      <ErrorBox error={s.error} />
      <label className="field" data-invalid={tried && invalid}>
        <span>{outcome === 'dismissed' ? 'Why dismiss it' : 'What was done (optional)'}</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} aria-invalid={tried && invalid} placeholder={outcome === 'dismissed' ? 'For example, the owner checked it themselves' : 'For example, officers sent to the market'} />
        {tried && invalid && <span className="field-error">Say why the match is dismissed.</span>}
      </label>
    </Sheet>
  );
}
