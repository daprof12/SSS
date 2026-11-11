'use client';

import { LinkButton } from '@erp/web-ui/LinkButton';
import { Sheet } from '@erp/web-ui/Sheet';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api, ApiError } from '@/lib/client';
import { Attachments, AttachPicker, uploadPicked, usePicked } from '@/components/reports/Attach';
import { chipTone, day, DocPicker, examples, IdentifierField, TypeTiles, useDocs, useItemTypes, type ItemType } from './shared';
import type { MyItem } from './StolenFlow';

interface StolenRow {
  id: string;
  publicNo: string;
  name: string;
  state: string;
  status: { chip: string; tone: string };
  matches: number;
  createdAt: string;
}

/** My items: what I registered, what I reported stolen, and the buyer checks I made. */
export function MyItems() {
  const [items, setItems] = useState<MyItem[] | null>(null);
  const [cases, setCases] = useState<StolenRow[] | null>(null);
  useEffect(() => {
    api<MyItem[]>('/me/items').then(setItems).catch(() => setItems([]));
    api<StolenRow[]>('/me/stolen-reports').then(setCases).catch(() => setCases([]));
  }, []);
  const registered = items?.filter((x) => x.registered) ?? null;
  return (
    <main className="app">
      <Header title="My items" />
      <p className="muted" style={{ marginTop: -8 }}>
        Register your phone, car or laptop now. If it is ever stolen, you report it in two taps and anyone who checks it before buying is warned.
      </p>

      {cases && cases.length > 0 && (
        <>
          <p className="section-label">Reported stolen</p>
          {cases.map((k) => (
            <Link key={k.id} href={`/stolen/${k.id}`} className={`inc sev-${k.status.tone === 'success' ? 'success' : k.status.tone === 'warning' ? 'warning' : 'info'}`}>
              <span className="grow">
                <strong style={{ textTransform: 'none' }}>{k.name}</strong>
                <span className="sub">
                  {k.publicNo} · {day(k.createdAt)}
                  {k.matches ? ` · ${k.matches} ${k.matches === 1 ? 'check' : 'checks'} by buyers` : ''}
                </span>
              </span>
              <span className={`chip ${k.status.tone}`}>{k.status.chip}</span>
            </Link>
          ))}
        </>
      )}

      <p className="section-label">Registered</p>
      {!registered && [0, 1].map((i) => <div key={i} className="skeleton" />)}
      {registered?.length === 0 && (
        <div className="empty">
          <strong>Nothing registered yet.</strong>
          Add the IMEI, chassis number or serial number with your receipt.
        </div>
      )}
      {registered && registered.length > 0 && (
        <div className="list">
          {registered.map((x) => (
            <Link key={x.id} href={`/items/${x.id}`} className="row">
              <span className="icon">
                <Icon name={x.icon} />
              </span>
              <span className="grow">
                <strong>{x.name}</strong>
                <span className="sub">
                  {x.typeLabel} · {x.identifierLabel} ••••{x.identifier.slice(-4)}
                </span>
              </span>
              {x.stolen ? <span className="chip warning">Stolen</span> : !x.proofComplete ? <span className="chip neutral">Add proof</span> : null}
              <Icon name="chevron" size={18} />
            </Link>
          ))}
        </div>
      )}
      <LinkButton href="/items/new" className="btn block primary" style={{ marginTop: 12 }}>
        <Icon name="plus" /> Register an item
      </LinkButton>
      <div className="btn-row" style={{ marginTop: 8 }}>
        <LinkButton href="/stolen/new" className="btn">
          Report stolen
        </LinkButton>
        <LinkButton href="/check" className="btn">
          Check an item
        </LinkButton>
      </div>
    </main>
  );
}

/** Register an item: type, identifier, make and model, photos and the proof the type asks for. */
export function RegisterItem() {
  const router = useRouter();
  const types = useItemTypes();
  const [type, setType] = useState<ItemType | null>(null);
  const [identifier, setIdentifier] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [colour, setColour] = useState('');
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<null | 'saving' | 'files'>(null);
  const photos = usePicked();
  const docs = useDocs();

  const save = async () => {
    setBusy('saving');
    setErrs({});
    try {
      const r = await api<{ id: string }>('/me/items', {
        method: 'POST',
        body: JSON.stringify({ typeCode: type!.code, identifier, make: make.trim() || undefined, model: model.trim() || undefined, colour: colour.trim() || undefined }),
      });
      let failed = 0;
      if (photos.items.length || Object.keys(docs.files).length) {
        setBusy('files');
        failed = (await uploadPicked('owned_item', r.id, photos)) + (await docs.upload('owned_item', r.id));
      }
      router.replace(`/items/${r.id}?added=1${failed ? `&files=${failed}` : ''}`);
    } catch (x) {
      if (x instanceof ApiError && x.code === 'already_registered' && typeof x.extra.itemId === 'string') return router.replace(`/items/${x.extra.itemId}`);
      if (x instanceof ApiError && x.fields?.length) setErrs(Object.fromEntries(x.fields.map((f) => [f.field, f.message])));
      else setErrs({ form: x instanceof ApiError ? x.message : 'Could not save. Try again.' });
      setBusy(null);
    }
  };

  return (
    <main className="app bare">
      <Header title="Register an item" />
      {errs.form && (
        <div className="banner critical" role="alert">
          {errs.form}
        </div>
      )}
      <TypeTiles types={types} value={type?.code ?? null} onChange={(t) => (setType(t), setErrs({}))} />
      {type && (
        <>
          <IdentifierField type={type} value={identifier} onChange={setIdentifier} error={errs.identifier} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label className="field">
              <span>Make</span>
              <input value={make} onChange={(e) => setMake(e.target.value)} maxLength={60} placeholder={examples(type.code)[0]} />
            </label>
            <label className="field">
              <span>Model</span>
              <input value={model} onChange={(e) => setModel(e.target.value)} maxLength={60} placeholder={examples(type.code)[1]} />
            </label>
          </div>
          <label className="field">
            <span>Colour (optional)</span>
            <input value={colour} onChange={(e) => setColour(e.target.value)} maxLength={40} />
          </label>
          <DocPicker docs={type.documents} picked={docs} disabled={!!busy} />
          <p className="section-label">Photos (optional)</p>
          <AttachPicker picked={photos} disabled={!!busy} />
          <button className="btn block primary" type="button" onClick={save} disabled={!!busy || !identifier.trim()}>
            {busy === 'files' ? 'Sending files…' : busy ? 'Saving…' : 'Register'}
          </button>
          <p className="muted center">Only you can see your items. The police see one only if you report it stolen.</p>
        </>
      )}
    </main>
  );
}

interface ItemFull {
  id: string;
  type: string;
  typeLabel: string;
  icon: string;
  name: string;
  make: string | null;
  model: string | null;
  colour: string | null;
  identifierLabel: string;
  identifier: string;
  registeredAt: string;
  documents: Array<{ code: string; label: string; required: boolean; provided: boolean }>;
  proofComplete: boolean;
  openCase: { id: string; publicNo: string; state: string; status: { chip: string; tone: string; line: string } } | null;
  cases: Array<{ id: string; publicNo: string; state: string; label: string; createdAt: string }>;
  canReport: boolean;
  canRemove: boolean;
}

export function ItemDetail({ id }: { id: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [it, setIt] = useState<ItemFull | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useToast();
  const [sheet, setSheet] = useState<'remove' | 'proof' | null>(null);
  const [refresh, setRefresh] = useState(0);
  const docs = useDocs();
  const photos = usePicked();
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<ItemFull>(`/me/items/${id}`).then(setIt).catch((e: ApiError) => setErr(e.message)), [id]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (params.get('added') === '1') setToast(Number(params.get('files') ?? 0) ? 'Registered, but some files did not upload. Add them again.' : 'Registered.');
  }, [params, setToast]);

  if (err) return <main className="app bare"><Header back="/items" /><div className="card empty"><strong>{err}</strong></div></main>;
  if (!it) return <main className="app bare">{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 90 }} />)}</main>;

  const missing = it.documents.filter((d) => d.required && !d.provided);
  return (
    <main className="app bare">
      <Header title={it.name} back="/items">
        {it.openCase && <span className={`chip ${it.openCase.status.tone}`}>Stolen</span>}
      </Header>
      {it.openCase && (
        <Link href={`/stolen/${it.openCase.id}`} className="banner warning" style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
          <strong>Reported stolen · {it.openCase.publicNo}</strong>
          {it.openCase.status.line} Follow the recovery
        </Link>
      )}
      <div className="card">
        <dl className="facts" style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px' }}>
          <dt className="muted">Type</dt>
          <dd style={{ margin: 0 }}>{it.typeLabel}</dd>
          <dt className="muted">{it.identifierLabel}</dt>
          <dd style={{ margin: 0, fontFamily: 'var(--font-mono, ui-monospace, monospace)', wordBreak: 'break-all' }}>{it.identifier}</dd>
          {it.colour && (
            <>
              <dt className="muted">Colour</dt>
              <dd style={{ margin: 0 }}>{it.colour}</dd>
            </>
          )}
          <dt className="muted">Registered</dt>
          <dd style={{ margin: 0 }}>{day(it.registeredAt)}</dd>
        </dl>
      </div>

      {missing.length > 0 && (
        <div className="banner warning">
          <strong>Add your proof</strong>
          {missing.map((d) => d.label).join(', ')}. The police need it to return the item to you.
        </div>
      )}
      <div className="list">
        {it.documents.map((d) => (
          <div key={d.code} className="row" style={{ cursor: 'default' }}>
            <span className="icon">
              <Icon name={d.provided ? 'check' : 'article'} />
            </span>
            <span className="grow">
              <strong>{d.label}</strong>
              <span className="sub">{d.provided ? 'Added' : d.required ? 'Missing' : 'Optional'}</span>
            </span>
          </div>
        ))}
      </div>
      <Attachments ownerType="owned_item" ownerId={id} refreshKey={refresh} title="Photos and documents" />
      <button className="btn block" type="button" onClick={() => setSheet('proof')} style={{ marginTop: 8 }}>
        <Icon name="plus" /> Add photos or proof
      </button>

      {it.canReport && (
        <Link href={`/stolen/new?item=${id}`} className="btn block primary" style={{ marginTop: 8 }}>
          <Icon name="flag" /> Report stolen
        </Link>
      )}
      {it.cases.filter((k) => k.id !== it.openCase?.id).length > 0 && (
        <>
          <p className="section-label">Earlier reports</p>
          <div className="list">
            {it.cases
              .filter((k) => k.id !== it.openCase?.id)
              .map((k) => (
                <Link key={k.id} href={`/stolen/${k.id}`} className="row">
                  <span className="grow">
                    <strong>{k.publicNo}</strong>
                    <span className="sub">{day(k.createdAt)}</span>
                  </span>
                  <span className={`chip ${chipTone(k.state)}`}>{k.label}</span>
                </Link>
              ))}
          </div>
        </>
      )}
      {it.canRemove && (
        <button className="link-btn" type="button" onClick={() => setSheet('remove')} style={{ display: 'block', margin: '12px auto 0', color: 'var(--color-emergency-text)' }}>
          Remove from my items
        </button>
      )}

      <Sheet
        open={sheet === 'proof'}
        title="Add photos or proof"
        onClose={() => setSheet(null)}
        footer={
          <button
            className="btn primary block"
            type="button"
            disabled={busy || (!photos.items.length && !Object.keys(docs.files).length)}
            onClick={async () => {
              setBusy(true);
              const failed = (await uploadPicked('owned_item', id, photos)) + (await docs.upload('owned_item', id));
              setBusy(false);
              if (failed) return setToast('Some files did not upload. Try again.');
              photos.clear();
              Object.keys(docs.files).forEach((k) => docs.set(k, null));
              setSheet(null);
              setRefresh((n) => n + 1);
              setToast('Added.');
              void load();
            }}
          >
            {busy ? 'Sending…' : 'Add'}
          </button>
        }
      >
        <DocPicker docs={it.documents} picked={docs} have={it.documents.filter((d) => d.provided).map((d) => d.code)} disabled={busy} />
        <AttachPicker picked={photos} disabled={busy} />
      </Sheet>
      <Sheet
        open={sheet === 'remove'}
        title="Remove this item?"
        description="It leaves your list and is no longer protected. You can register it again later."
        onClose={() => setSheet(null)}
        footer={
          <>
            <button className="btn" type="button" onClick={() => setSheet(null)}>
              Keep it
            </button>
            <button
              className="btn primary"
              type="button"
              onClick={async () => {
                try {
                  await api(`/me/items/${id}`, { method: 'DELETE' });
                  router.replace('/items');
                } catch (e) {
                  setSheet(null);
                  setToast(e instanceof ApiError ? e.message : 'Could not remove it.');
                }
              }}
            >
              Remove
            </button>
          </>
        }
      >
        {null}
      </Sheet>
      <Toast msg={toast} />
    </main>
  );
}
