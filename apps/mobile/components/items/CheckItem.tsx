'use client';

import { CHECK_CONTEXTS, type CheckContext } from '@erp/domain';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api, ApiError, haptic, locate } from '@/lib/client';
import { day, IdentifierField, TypeTiles, useItemTypes, type ItemType } from './shared';

interface Result {
  id: string;
  checkNo: string;
  at: string;
  typeLabel: string;
  identifierLabel: string;
  identifier: string;
  result: 'clean' | 'stolen';
  stolen: { item: string; colour: string | null; publicNo: string; yours: boolean } | null;
}
interface PastCheck {
  id: string;
  checkNo: string;
  result: 'clean' | 'stolen';
  typeLabel: string;
  identifierLabel: string;
  identifier: string;
  at: string;
}

/**
 * Check before you buy (used car, phone or laptop). Clean or reported stolen; a stolen result goes
 * to the police with where the check was made, so an innocent buyer is on record as having checked.
 */
export function CheckItem() {
  const types = useItemTypes();
  const [type, setType] = useState<ItemType | null>(null);
  const [identifier, setIdentifier] = useState('');
  const [context, setContext] = useState<CheckContext>('buying');
  const [spot, setSpot] = useState<{ lat: number; lng: number; accuracy?: number } | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [past, setPast] = useState<PastCheck[] | null>(null);

  useEffect(() => {
    if (types && !type) setType(types.find((t) => t.code === 'phone') ?? types[0] ?? null);
  }, [types, type]);
  useEffect(() => {
    // Quietly, so the police know where a stolen item was offered; the check works without it.
    void locate(8000).then(setSpot);
    api<PastCheck[]>('/me/item-checks').then(setPast).catch(() => setPast([]));
  }, []);

  const run = async () => {
    setBusy(true);
    setErrs({});
    try {
      const r = await api<Result>('/item-checks', {
        method: 'POST',
        body: JSON.stringify({ typeCode: type!.code, identifier, context, ...(spot ? { lat: spot.lat, lng: spot.lng, accuracy: spot.accuracy } : {}) }),
      });
      haptic(r.result === 'stolen' ? [80, 60, 80] : 20);
      setResult(r);
      api<PastCheck[]>('/me/item-checks').then(setPast).catch(() => {});
    } catch (x) {
      if (x instanceof ApiError && x.fields?.length) setErrs(Object.fromEntries(x.fields.map((f) => [f.field, f.message])));
      else setErrs({ form: x instanceof ApiError ? x.message : 'Could not check. Try again.' });
    }
    setBusy(false);
  };

  if (result) return <CheckResult r={result} onAgain={() => (setResult(null), setIdentifier(''))} />;

  return (
    <main className="app bare">
      <Header title="Check before you buy" />
      <p className="muted" style={{ marginTop: -8 }}>
        Buying a used phone, car or laptop? Check it first. If it was reported stolen, you will know before you pay.
      </p>
      {errs.form && (
        <div className="banner critical" role="alert">
          {errs.form}
        </div>
      )}
      <TypeTiles types={types} value={type?.code ?? null} onChange={(t) => (setType(t), setErrs({}))} label="What are you checking?" />
      {type && <IdentifierField type={type} value={identifier} onChange={setIdentifier} error={errs.identifier} />}
      <div className="field">
        <span>Why are you checking?</span>
        <div className="chips">
          {CHECK_CONTEXTS.map((c) => (
            <button key={c.code} type="button" aria-pressed={context === c.code} onClick={() => setContext(c.code)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <button className="btn block primary" type="button" onClick={run} disabled={busy || !type || !identifier.trim()}>
        <Icon name="search" /> {busy ? 'Checking…' : 'Check'}
      </button>
      <p className="muted center" style={{ fontSize: 'var(--text-sm)' }}>
        {spot ? 'Your location' : 'Your location, if you allow it,'} is passed to the police only if the item is reported stolen. The seller is never told.
      </p>

      {past && past.length > 0 && (
        <>
          <p className="section-label">Your checks</p>
          <div className="list">
            {past.slice(0, 10).map((c) => (
              <div key={c.id} className="row" style={{ cursor: 'default' }}>
                <span className="grow">
                  <strong>
                    {c.typeLabel} ••••{c.identifier.slice(-4)}
                  </strong>
                  <span className="sub">
                    {c.checkNo} · {day(c.at)}
                  </span>
                </span>
                <span className={`chip ${c.result === 'stolen' ? 'critical' : 'success'}`}>{c.result === 'stolen' ? 'Stolen' : 'Clean'}</span>
              </div>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
            Keep the reference. It shows you checked before you bought.
          </p>
        </>
      )}
    </main>
  );
}

function CheckResult({ r, onAgain }: { r: Result; onAgain: () => void }) {
  const [sellerName, setSellerName] = useState('');
  const [sellerPhone, setSellerPhone] = useState('');
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const when = new Date(r.at).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  if (r.result === 'clean') {
    return (
      <main className="app bare">
        <Header title="Check result" back={false} />
        <div className="check-result clean" role="status">
          <span className="check-mark" aria-hidden>
            <Icon name="check" size={40} />
          </span>
          <h2>Not reported stolen</h2>
          <p>
            No one has reported this {r.typeLabel.toLowerCase()} stolen.
            <br />
            {r.identifierLabel} {r.identifier}
          </p>
        </div>
        <div className="card">
          <strong style={{ display: 'block' }}>Reference {r.checkNo}</strong>
          <span className="muted">Checked {when}. Keep this reference: it shows you checked before you bought.</span>
        </div>
        <div className="banner info">
          <strong>Before you pay</strong>
          Ask for the receipt or papers, and check the {r.identifierLabel} on the item itself matches. A very low price is a warning sign.
        </div>
        <button className="btn block primary" type="button" onClick={onAgain}>
          Check another item
        </button>
      </main>
    );
  }

  if (r.stolen?.yours) {
    return (
      <main className="app bare">
        <Header title="Check result" back={false} />
        <div className="check-result stolen" role="alert">
          <span className="check-mark" aria-hidden>
            <Icon name="flag" size={40} />
          </span>
          <h2>This is your stolen item</h2>
          <p>You reported it stolen ({r.stolen.publicNo}). Buyers who check it are warned.</p>
        </div>
        <Link href="/items" className="btn block primary">
          Open my items
        </Link>
        <button className="btn block" type="button" onClick={onAgain} style={{ marginTop: 8 }}>
          Check another item
        </button>
      </main>
    );
  }

  const send = async () => {
    setBusy(true);
    setErrs({});
    try {
      await api(`/item-checks/${r.id}/details`, { method: 'POST', body: JSON.stringify({ sellerName: sellerName.trim() || undefined, sellerPhone: sellerPhone.trim() || undefined, note: note.trim() || undefined }) });
      setSent(true);
    } catch (x) {
      if (x instanceof ApiError && x.fields?.length) setErrs(Object.fromEntries(x.fields.map((f) => [f.field, f.message])));
      else setErrs({ form: x instanceof ApiError ? x.message : 'Could not send. Try again.' });
    }
    setBusy(false);
  };

  return (
    <main className="app bare">
      <Header title="Check result" back={false} />
      <div className="check-result stolen" role="alert">
        <span className="check-mark" aria-hidden>
          <Icon name="flag" size={40} />
        </span>
        <h2>Reported stolen. Do not buy.</h2>
        <p>
          {r.stolen!.item}
          {r.stolen!.colour ? `, ${r.stolen!.colour.toLowerCase()}` : ''}
          <br />
          {r.identifierLabel} {r.identifier}
        </p>
      </div>
      <div className="banner warning">
        <strong>Stay safe</strong>
        Do not confront the seller or say what you found. Walk away calmly. If you feel in danger, use <Link href="/report?type=robbery">SOS</Link>.
      </div>
      <div className="card">
        <strong style={{ display: 'block' }}>The police have been told</strong>
        <span className="muted">
          Reference {r.checkNo}, {when}. Your check is on record: it shows you checked and did not buy.
        </span>
      </div>

      {sent ? (
        <div className="banner success" role="status">
          <strong>Thank you</strong>The police have your details on the seller.
        </div>
      ) : (
        <>
          <p className="section-label">Help the police (optional)</p>
          {errs.form && (
            <div className="banner critical" role="alert">
              {errs.form}
            </div>
          )}
          <label className="field">
            <span>Seller's name or description</span>
            <input value={sellerName} onChange={(e) => setSellerName(e.target.value)} maxLength={80} placeholder="e.g. Young man in a red cap" />
          </label>
          <label className="field" data-invalid={!!errs.sellerPhone}>
            <span>Seller's phone number</span>
            <input value={sellerPhone} onChange={(e) => setSellerPhone(e.target.value)} inputMode="tel" maxLength={20} aria-invalid={!!errs.sellerPhone} />
            {errs.sellerPhone && <span className="field-error">{errs.sellerPhone}</span>}
          </label>
          <label className="field" data-invalid={!!errs.note}>
            <span>Where it is being sold, the price, anything else</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} style={{ minHeight: 90 }} />
            {errs.note && <span className="field-error">{errs.note}</span>}
          </label>
          <button className="btn block signal" type="button" disabled={busy || (!sellerName.trim() && !sellerPhone.trim() && !note.trim())} onClick={send}>
            {busy ? 'Sending…' : 'Send to the police'}
          </button>
        </>
      )}
      <button className="btn block" type="button" onClick={onAgain} style={{ marginTop: 8 }}>
        Check another item
      </button>
    </main>
  );
}
