'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api, ApiError, uid } from '@/lib/client';
import { AttachPicker, uploadPicked, usePicked } from '@/components/reports/Attach';
import { WherePicker, whereBody, type Where } from '@/components/reports/WherePicker';
import { DocPicker, examples, IdentifierField, lagosToday, TypeTiles, useDocs, useItemTypes, type ItemType } from './shared';

export interface MyItem {
  id: string;
  type: string;
  typeLabel: string;
  icon: string;
  name: string;
  identifierLabel: string;
  identifier: string;
  registered: boolean;
  proofComplete: boolean;
  stolen: { caseId: string; publicNo: string; state: string; status: { chip: string; tone: string } } | null;
  lastCase: { id: string; publicNo: string; state: string; label: string } | null;
}

/**
 * Report a stolen item. A registered item is two taps: pick it, confirm where, send. An item that
 * was never registered takes its type and identifier here.
 */
export function StolenFlow({ itemId }: { itemId?: string | null }) {
  const router = useRouter();
  const types = useItemTypes();
  const [items, setItems] = useState<MyItem[] | null>(null);
  const [item, setItem] = useState<MyItem | null>(null);
  const [type, setType] = useState<ItemType | null>(null);
  const [step, setStep] = useState<'pick' | 'details'>(itemId ? 'details' : 'pick');
  const [identifier, setIdentifier] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [stolenOn, setStolenOn] = useState(lagosToday());
  const [where, setWhere] = useState<Where | null>(null);
  const [text, setText] = useState('');
  const [reportNo, setReportNo] = useState('');
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<null | 'sending' | 'files'>(null);
  const clientRef = useRef(uid());
  const photos = usePicked();
  const docs = useDocs();

  useEffect(() => {
    api<MyItem[]>('/me/items')
      .then((xs) => {
        const mine = xs.filter((x) => x.registered);
        setItems(mine);
        if (itemId) {
          const hit = mine.find((x) => x.id === itemId) ?? null;
          setItem(hit);
          if (!hit) setStep('pick');
        }
      })
      .catch(() => setItems([]));
  }, [itemId]);

  const docTypes = types?.find((t) => t.code === (item?.type ?? type?.code))?.documents ?? [];

  const send = async () => {
    const e: Record<string, string> = {};
    if (!where || where.kind === 'none') e.where = 'Add where it was stolen.';
    if (!stolenOn) e.stolenOn = 'Choose the day it was stolen.';
    setErrs(e);
    if (Object.keys(e).length) return requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-invalid="true"] input, [data-invalid="true"] button')?.focus());
    setBusy('sending');
    try {
      const body = {
        ...(item ? { itemId: item.id } : { item: { typeCode: type!.code, identifier, make: make.trim() || undefined, model: model.trim() || undefined } }),
        stolenOn,
        circumstances: text.trim() || undefined,
        policeReportNo: reportNo.trim() || undefined,
        clientRef: clientRef.current,
        ...whereBody(where!),
      };
      const r = await api<{ id: string }>('/stolen-reports', { method: 'POST', body: JSON.stringify(body) });
      // The report is in; files follow. A failed file never loses the report.
      let failed = 0;
      if (photos.items.length || Object.keys(docs.files).length) {
        setBusy('files');
        failed = (await uploadPicked('stolen_case', r.id, photos)) + (await docs.upload('stolen_case', r.id));
      }
      router.replace(`/stolen/${r.id}?sent=1${failed ? `&files=${failed}` : ''}`);
    } catch (x) {
      if (x instanceof ApiError && x.code === 'already_reported' && typeof x.extra.caseId === 'string') {
        router.replace(`/stolen/${x.extra.caseId}`);
        return;
      }
      if (x instanceof ApiError && x.fields?.length) {
        setErrs(Object.fromEntries(x.fields.map((f) => {
          const k = f.field.replace(/^item\./, '');
          return [k === 'postcode' ? 'where' : k, f.message];
        })));
      }
      else setErrs({ form: x instanceof ApiError ? x.message : 'Could not send. Try again.' });
      setBusy(null);
    }
  };

  if (step === 'details' && (item || type)) {
    return (
      <main className="app bare">
        <Header title="Report stolen" back={false}>
          <button className="link-btn" type="button" onClick={() => (setStep('pick'), setItem(null))}>
            Change
          </button>
        </Header>
        {errs.form && (
          <div className="banner critical" role="alert">
            {errs.form}
          </div>
        )}
        {item ? (
          <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span className="pin" style={{ width: 44, height: 44 }}>
              <Icon name={item.icon} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <strong style={{ display: 'block' }}>{item.name}</strong>
              <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>
                {item.identifierLabel} {item.identifier}
              </span>
            </span>
          </div>
        ) : (
          <>
            <IdentifierField type={type!} value={identifier} onChange={setIdentifier} error={errs.identifier} autoFocus />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <label className="field">
                <span>Make</span>
                <input value={make} onChange={(e) => setMake(e.target.value)} maxLength={60} placeholder={examples(type?.code)[0]} />
              </label>
              <label className="field">
                <span>Model</span>
                <input value={model} onChange={(e) => setModel(e.target.value)} maxLength={60} placeholder={examples(type?.code)[1]} />
              </label>
            </div>
          </>
        )}

        <WherePicker value={where} onChange={setWhere} autoLocate error={errs.where} />
        <label className="field" data-invalid={!!errs.stolenOn}>
          <span>When was it stolen?</span>
          <input type="date" value={stolenOn} max={lagosToday()} onChange={(e) => setStolenOn(e.target.value)} aria-invalid={!!errs.stolenOn} />
          {errs.stolenOn && <span className="field-error">{errs.stolenOn}</span>}
        </label>
        <label className="field">
          <span>What happened (optional)</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} placeholder="How it was taken, anyone you saw, a vehicle or plate." style={{ minHeight: 100 }} />
        </label>
        <label className="field">
          <span>Police report number (optional)</span>
          <input value={reportNo} onChange={(e) => setReportNo(e.target.value)} maxLength={40} placeholder="If you already reported it at a station" />
        </label>
        <p className="section-label">Photos of the item (optional)</p>
        <AttachPicker picked={photos} disabled={!!busy} />
        <DocPicker docs={docTypes} picked={docs} optionalAll disabled={!!busy} />

        <button className="btn block primary" type="button" onClick={send} disabled={!!busy}>
          {busy === 'files' ? 'Sending files…' : busy ? 'Sending…' : 'Report to the police'}
        </button>
        <p className="muted center">Anyone who checks it before buying is told it is stolen, and the police are told where.</p>
      </main>
    );
  }

  const free = items?.filter((x) => !x.stolen) ?? null;
  return (
    <main className="app bare">
      <Header title="Report a stolen item" />
      <p className="muted" style={{ marginTop: -8 }}>
        If it is happening now or someone is hurt, use <Link href="/report?type=robbery">SOS</Link>.
      </p>
      {free && free.length > 0 && (
        <>
          <p className="section-label">Your registered items</p>
          <div className="list">
            {free.map((x) => (
              <button
                key={x.id}
                type="button"
                className="row"
                style={{ width: '100%', font: 'inherit', textAlign: 'left', color: 'inherit', border: 0 }}
                onClick={() => {
                  setItem(x);
                  setType(null);
                  setStep('details');
                }}
              >
                <span className="icon">
                  <Icon name={x.icon} />
                </span>
                <span className="grow">
                  <strong>{x.name}</strong>
                  <span className="sub">
                    {x.identifierLabel} ••••{x.identifier.slice(-4)}
                  </span>
                </span>
                <Icon name="chevron" size={18} />
              </button>
            ))}
          </div>
        </>
      )}
      {!items && <div className="skeleton" style={{ height: 64 }} />}
      <TypeTiles types={types} value={type?.code ?? null} onChange={(t) => (setItem(null), setType(t))} label={free?.length ? 'Or another item' : 'What was stolen?'} />
      <button className="btn block primary" type="button" disabled={!type} onClick={() => setStep('details')} style={{ marginTop: 8 }}>
        {type ? 'Continue' : 'Choose what was stolen'}
      </button>
      <p className="muted center">
        Register your things before anything happens: <Link href="/items/new">add an item</Link>.
      </p>
    </main>
  );
}
