'use client';
// Board "Officer report and tip": file an incident report from the field (photo, voice note,
// link to an incident you are on), or switch to a tip that can earn a bounty.
import { Sheet } from '@erp/web-ui/Sheet';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { dateTime } from '@/components/officer/work';
import { AttachPicker, uploadPicked, usePicked } from '@/components/reports/Attach';
import { BuildingPicker, formatPostcode } from '@/components/reports/BuildingPicker';
import { api, ApiError, haptic, locate, TYPES, uid } from '@/lib/client';

type Where = { kind: 'postcode'; postcode: string; label: string } | { kind: 'here'; lat: number; lng: number; label: string };
interface Linkable {
  id: string;
  title: string;
  live: boolean;
}
interface Mine {
  id: string;
  title: string;
  description: string;
  at: string;
  linked: boolean;
  files: number;
}
const SHORT: Record<string, string> = { medical: 'Health', violence: 'Violence', other: 'Other' };

export default function OfficerReport() {
  const [type, setType] = useState<string | null>(null);
  const [where, setWhere] = useState<Where | null>(null);
  const [picking, setPicking] = useState(false);
  const [locating, setLocating] = useState(true);
  const [text, setText] = useState('');
  const [link, setLink] = useState<Linkable | null>(null);
  const [linking, setLinking] = useState(false);
  const [linkable, setLinkable] = useState<Linkable[] | null>(null);
  const [mine, setMine] = useState<Mine[] | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'sending' | 'files' | null>(null);
  const [toast, setToast] = useToast();
  const picked = usePicked();
  const clientRef = useRef(uid());

  const loadMine = () => api<Mine[]>('/me/officer/field-reports').then(setMine).catch(() => setMine([]));
  useEffect(() => {
    void loadMine();
    // "From your location": the nearest building to the officer, changeable on the map.
    void locate().then(async (p) => {
      setLocating(false);
      if (!p) return;
      const b = await api<{ postcode: string; address: string }>(`/places/nearest?lat=${p.lat}&lng=${p.lng}`).catch(() => null);
      setWhere((w) => w ?? (b ? { kind: 'postcode', postcode: b.postcode, label: `${b.address}, ${formatPostcode(b.postcode)}` } : { kind: 'here', lat: p.lat, lng: p.lng, label: 'Where you are now (GPS)' }));
    });
  }, []);
  useEffect(() => {
    if (linking && !linkable) void api<Linkable[]>('/me/officer/field-reports/linkable').then(setLinkable).catch(() => setLinkable([]));
  }, [linking, linkable]);

  const send = async () => {
    const e: Record<string, string> = {};
    if (!type) e.type = 'Choose what you are reporting.';
    if (!where) e.where = 'Add where it is: pick the building on the map.';
    if (text.trim().length < 10) e.description = 'Say what you saw in a sentence or two.';
    setErrs(e);
    if (Object.keys(e).length) return requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-invalid="true"] button, [data-invalid="true"] textarea')?.focus());
    setBusy('sending');
    try {
      const r = await api<{ id: string }>('/me/officer/field-reports', {
        method: 'POST',
        body: JSON.stringify({
          type,
          description: text.trim(),
          ...(where!.kind === 'postcode' ? { postcode: where!.postcode } : { lat: where!.lat, lng: where!.lng }),
          ...(link ? { incidentId: link.id } : {}),
          clientRef: clientRef.current,
        }),
      });
      let failed = 0;
      if (picked.items.length) {
        setBusy('files');
        failed = await uploadPicked('field_report', r.id, picked);
      }
      haptic([10, 40, 10]);
      setToast(failed ? 'Report sent, but some files did not upload.' : link ? `Report sent and added to ${link.title}.` : 'Report sent to your station.');
      setType(null);
      setText('');
      setLink(null);
      picked.clear();
      clientRef.current = uid();
      void loadMine();
    } catch (x) {
      if (x instanceof ApiError && x.fields?.length) setErrs(Object.fromEntries(x.fields.map((f) => [f.field, f.message])));
      else setErrs({ form: x instanceof ApiError ? x.message : 'Could not send. Try again.' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="app">
      <Header title="Report" back={false} />
      <p className="muted" style={{ marginTop: -8 }}>
        File a report from the field. Choose what you are reporting.
      </p>
      <div className="seg-big" role="tablist" aria-label="Report type">
        <button type="button" role="tab" aria-selected="true">
          Incident report
        </button>
        <Link href="/officer/tips/new" role="tab" aria-selected="false">
          Tip, earn a bounty
        </Link>
      </div>
      {errs.form && (
        <div className="banner critical" role="alert">
          {errs.form}
        </div>
      )}

      <div className="field" data-invalid={!!errs.type}>
        <div className="type-grid" role="radiogroup" aria-label="What happened">
          {TYPES.map((t) => (
            <button key={t.code} type="button" role="radio" aria-checked={type === t.code} className="type-cell" onClick={() => (setType(t.code), haptic(6))}>
              {SHORT[t.code] ?? t.label}
            </button>
          ))}
        </div>
        {errs.type && <span className="field-error">{errs.type}</span>}
      </div>

      <div className="field" data-invalid={!!errs.where}>
        <button type="button" className="location-line" style={{ width: '100%', border: 0, textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer' }} onClick={() => setPicking(true)}>
          <span className="pin" style={{ width: 40, height: 40 }}>
            <Icon name="pin" size={20} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <strong style={{ display: 'block' }}>{where ? where.label : locating ? 'Finding your location…' : 'Pick the building on the map'}</strong>
            <span className="muted" style={{ fontSize: 'var(--text-xs, 12px)' }}>
              {where ? 'From your location, tap to change' : locating ? 'Or tap to pick it on the map' : 'Location is off. Tap to choose where it is.'}
            </span>
          </span>
        </button>
        {errs.where && <span className="field-error">{errs.where}</span>}
      </div>

      <label className="field" data-invalid={!!errs.description}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} placeholder="What did you see?" aria-label="What did you see?" aria-invalid={!!errs.description} style={{ minHeight: 120 }} />
        {errs.description && <span className="field-error">{errs.description}</span>}
      </label>

      <AttachPicker picked={picked} disabled={!!busy} />
      <button type="button" className={`btn block ${link ? 'signal' : ''}`} style={{ marginBottom: 12 }} onClick={() => setLinking(true)}>
        <Icon name="flag" /> {link ? `Linked to ${link.title}` : 'Link to incident'}
      </button>

      <button className="btn block primary" type="button" onClick={send} disabled={!!busy} style={{ minHeight: 60 }}>
        {busy === 'files' ? 'Sending files…' : busy ? 'Sending…' : 'Send report'}
      </button>

      <p className="section-label">Your field reports</p>
      {!mine ? (
        <div className="skeleton" />
      ) : !mine.length ? (
        <p className="muted">Reports you file show here. Your station head sees them too.</p>
      ) : (
        <div className="list">
          {mine.slice(0, 10).map((m) => (
            <div key={m.id} className="row" style={{ cursor: 'default' }}>
              <span className="grow">
                <strong>{m.title}</strong>
                <span className="sub">
                  {dateTime(m.at)}
                  {m.linked ? ' · linked' : ''}
                  {m.files ? ` · ${m.files} ${m.files === 1 ? 'file' : 'files'}` : ''}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      <p className="section-label">Also</p>
      <div className="list">
        <Link href="/officer/issues/new" className="row">
          <span className="icon">
            <Icon name="road" />
          </span>
          <span className="grow">
            <strong>Report a public issue</strong>
            <span className="sub">Bad road, broken light, waste seen on patrol</span>
          </span>
          <Icon name="chevron" size={18} />
        </Link>
        <Link href="/officer/tips" className="row">
          <span className="grow">
            <strong>My tips and bounties</strong>
          </span>
          <Icon name="chevron" size={18} />
        </Link>
        <Link href="/officer/issues" className="row">
          <span className="grow">
            <strong>My public issues</strong>
          </span>
          <Icon name="chevron" size={18} />
        </Link>
      </div>

      {picking && (
        <BuildingPicker
          onClose={() => setPicking(false)}
          onPick={(b) => {
            setWhere({ kind: 'postcode', postcode: b.postcode, label: `${b.address}, ${formatPostcode(b.postcode)}` });
            setPicking(false);
          }}
          onSpot={(s) => {
            setWhere({ kind: 'here', lat: s.lat, lng: s.lng, label: 'The spot you picked on the map' });
            setPicking(false);
          }}
        />
      )}
      {linking && (
        <Sheet
          open
          title="Link to incident"
          description="The report is added to that incident's response log."
          onClose={() => setLinking(false)}
          footer={
            <>
              {link && (
                <button className="btn" type="button" onClick={() => (setLink(null), setLinking(false))}>
                  Remove link
                </button>
              )}
              <button className="btn" type="button" onClick={() => setLinking(false)}>
                Close
              </button>
            </>
          }
        >
          {!linkable ? (
            <div className="skeleton" />
          ) : !linkable.length ? (
            <p className="muted">No incidents to link. You can link incidents you are on, or closed in the last day.</p>
          ) : (
            <div className="list">
              {linkable.map((l) => (
                <button key={l.id} type="button" className="row" aria-pressed={link?.id === l.id} onClick={() => (setLink(l), setLinking(false))}>
                  <span className="grow">
                    <strong>{l.title}</strong>
                    <span className="sub">{l.live ? 'You are on this now' : 'Closed today'}</span>
                  </span>
                  {link?.id === l.id && <Icon name="check" size={18} />}
                </button>
              ))}
            </div>
          )}
        </Sheet>
      )}
      <Toast msg={toast} />
    </main>
  );
}
