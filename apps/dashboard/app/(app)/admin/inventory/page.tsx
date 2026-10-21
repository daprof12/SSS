'use client';
// Board "Admin inventory": stock in each store, what is running low, and every movement in or
// between stores. Adding and moving stock is logged.
import { api, ApiError } from '@erp/web-ui/api';
import { Sheet } from '@erp/web-ui/Sheet';
import { useCallback, useEffect, useState } from 'react';
import { dateTime, useToast } from '@/components/Agency';
import { LocationFilter, locQuery, type LocFilter } from '@/components/LocationFilter';

interface Inv {
  items: { code: string; label: string }[];
  stats: { inStock: number; lowStock: number; installedThisMonth: number; inRepair: number };
  low: { store: string; item: string; quantity: number }[];
  stores: { id: string; name: string; postcode: string | null; area: string | null; stock: Record<string, { quantity: number; reorderAt: number }> }[];
  moves: { id: string; item: string; quantity: number; from: string | null; to: string | null; note: string | null; by: string; at: string }[];
}

export default function Inventory() {
  const [loc, setLoc] = useState<LocFilter>({});
  const [inv, setInv] = useState<Inv | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'add' | 'move' | null>(null);
  const [toast, setToast] = useToast();
  const lq = locQuery(loc);
  const load = useCallback(() => {
    api<Inv>(`/admin/inventory${lq ? `?${lq}` : ''}`)
      .then((x) => {
        setInv(x);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load inventory.'));
  }, [lq]);
  useEffect(load, [load]);
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>Inventory</h1>
          <p className="lede">Cameras, lights and parts in each store, ready for installs and repairs.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" type="button" disabled={!inv} onClick={() => setSheet('move')}>
            Transfer stock
          </button>
          <button className="btn primary" type="button" disabled={!inv} onClick={() => setSheet('add')}>
            Add stock
          </button>
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
          <span>Units in stock</span>
          <strong className="info">{inv?.stats.inStock ?? '—'}</strong>
          <small>All stores shown</small>
        </div>
        <div className="stat">
          <span>Low stock</span>
          <strong className="warning">{inv?.stats.lowStock ?? '—'}</strong>
          <small>At or below the reorder level</small>
        </div>
        <div className="stat">
          <span>Installed this month</span>
          <strong className="success">{inv?.stats.installedThisMonth ?? '—'}</strong>
          <small>Devices in homes and streets</small>
        </div>
        <div className="stat">
          <span>In repair</span>
          <strong className="critical">{inv?.stats.inRepair ?? '—'}</strong>
          <small>Needs repair or tamper</small>
        </div>
      </div>
      {!!inv?.low.length && (
        <div className="banner warning" role="status">
          Running low: {inv.low.map((l) => `${l.item} at ${l.store} (${l.quantity})`).join(', ')}.
        </div>
      )}
      <section className="card" style={{ padding: 0, overflowX: 'auto' }} aria-labelledby="stk">
        <h2 id="stk" style={{ margin: 0, padding: '16px 16px 0' }}>
          Stock by store
        </h2>
        {!inv ? (
          <div style={{ padding: 20 }}>
            <div className="skeleton" />
          </div>
        ) : !inv.stores.length ? (
          <div className="empty">No stores in this place.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Store</th>
                {inv.items.map((i) => (
                  <th key={i.code}>{i.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {inv.stores.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.name}</strong>
                    <div className="muted">
                      {s.postcode ?? '—'}
                      {s.area ? `, ${s.area}` : ''}
                    </div>
                  </td>
                  {inv.items.map((i) => {
                    const k = s.stock[i.code];
                    const low = k && k.quantity <= k.reorderAt;
                    return (
                      <td key={i.code} style={{ color: low ? 'var(--color-warning-text)' : undefined, fontWeight: low ? 700 : undefined }}>
                        {k ? k.quantity : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card" aria-labelledby="mv">
        <h2 id="mv" style={{ marginTop: 0 }}>
          Recent movements
        </h2>
        {!inv?.moves.length ? (
          <p className="muted">No stock has moved yet.</p>
        ) : (
          inv.moves.map((m) => (
            <div className="row" key={m.id}>
              <div className="label">
                <strong>
                  {m.quantity} {m.item.toLowerCase()} {m.from && m.to ? `from ${m.from} to ${m.to}` : m.to ? `into ${m.to}` : `out of ${m.from}`}
                </strong>
                <span>
                  {m.by}, {dateTime(m.at)}
                  {m.note ? `. ${m.note}` : ''}
                </span>
              </div>
            </div>
          ))
        )}
      </section>
      {sheet && inv && <StockSheet mode={sheet} inv={inv} onClose={() => setSheet(null)} onDone={(m) => (setSheet(null), setToast(m), load())} />}
    </>
  );
}

function StockSheet({ mode, inv, onClose, onDone }: { mode: 'add' | 'move'; inv: Inv; onClose: () => void; onDone: (m: string) => void }) {
  const [from, setFrom] = useState(inv.stores[0]?.id ?? '');
  const [to, setTo] = useState(inv.stores[1]?.id ?? inv.stores[0]?.id ?? '');
  const [item, setItem] = useState(inv.items[0]!.code);
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    setFields({});
    try {
      const body = mode === 'add' ? { storeId: to, item, quantity: Number(qty), note: note.trim() || undefined } : { from, to, item, quantity: Number(qty), note: note.trim() || undefined };
      onDone((await api<{ message: string }>(mode === 'add' ? '/admin/inventory/stock' : '/admin/inventory/transfer', { method: 'POST', body: JSON.stringify(body) })).message);
    } catch (e) {
      if (e instanceof ApiError) {
        setErr(e.message);
        setFields(Object.fromEntries((e.fields ?? []).map((f) => [f.field, f.message])));
      } else setErr('Could not save. Try again.');
      setBusy(false);
    }
  };
  const have = inv.stores.find((s) => s.id === from)?.stock[item]?.quantity ?? 0;
  return (
    <Sheet
      open
      title={mode === 'add' ? 'Add stock' : 'Transfer stock'}
      description={mode === 'add' ? 'Record stock received into a store.' : 'Move stock from one store to another.'}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={submit} disabled={busy || !qty}>
            {mode === 'add' ? 'Add' : 'Move'}
          </button>
        </>
      }
    >
      {err && (
        <div className="banner critical" role="alert" style={{ margin: 0 }}>
          {err}
        </div>
      )}
      {mode === 'move' && (
        <label className="field">
          <span>From</span>
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            {inv.stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field" data-invalid={!!fields.to || !!fields.storeId}>
        <span>{mode === 'add' ? 'Store' : 'To'}</span>
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          {inv.stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {(fields.to || fields.storeId) && <span className="field-error">{fields.to ?? fields.storeId}</span>}
      </label>
      <label className="field">
        <span>Item</span>
        <select value={item} onChange={(e) => setItem(e.target.value)}>
          {inv.items.map((i) => (
            <option key={i.code} value={i.code}>
              {i.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field" data-invalid={!!fields.quantity}>
        <span>Quantity{mode === 'move' ? ` (${have} in that store)` : ''}</span>
        <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} />
        {fields.quantity && <span className="field-error">{fields.quantity}</span>}
      </label>
      <label className="field">
        <span>Note (optional)</span>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder={mode === 'add' ? 'Supplier delivery number' : 'Why it moved'} />
      </label>
    </Sheet>
  );
}
