'use client';
// Platform admins add the kinds of item citizens can register, report stolen and check before
// buying. For each: what its unique identifier is called, how it is checked, and the proof owners give.
import { checkRule, validateIdentifier, type IdentifierRule, type ItemDocument } from '@erp/domain';
import { api, ApiError } from '@erp/web-ui/api';
import { ErrorBox, focusFirstError, useSubmit } from '@erp/web-ui/CloseReportSheet';
import { Sheet } from '@erp/web-ui/Sheet';
import { useEffect, useState } from 'react';
import { useToast } from '@/components/Agency';

interface ItemType {
  code: string;
  label: string;
  icon: string;
  identifierLabel: string;
  identifierHint: string;
  rule: IdentifierRule;
  documents: ItemDocument[];
  active: boolean;
  sort: number;
  items: number;
  openCases: number;
}

const ICONS: [string, string][] = [
  ['phone', 'Phone'],
  ['road', 'Vehicle'],
  ['article', 'Computer or document'],
  ['camera', 'Camera'],
  ['money', 'Valuables'],
  ['other', 'Other'],
];
const CHARSET: Record<IdentifierRule['charset'], string> = { digits: 'Digits only', alnum: 'Letters and digits', vin: 'VIN characters (no I, O, Q)' };
const CHECKSUM: Record<IdentifierRule['checksum'], string> = { none: 'None', luhn: 'Luhn check digit (IMEI)', vin: 'VIN check digit (9th character)' };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'x$1').slice(0, 30);
const ruleText = (r: IdentifierRule) =>
  [r.minLength === r.maxLength ? `${r.minLength} characters` : `${r.minLength}–${r.maxLength} characters`, CHARSET[r.charset].toLowerCase(), r.checksum !== 'none' ? CHECKSUM[r.checksum] : null, r.pattern ? `pattern ${r.pattern}` : null]
    .filter(Boolean)
    .join(', ');

export default function ItemTypesPage() {
  const [types, setTypes] = useState<ItemType[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [edit, setEdit] = useState<ItemType | 'new' | null>(null);
  const [toast, setToast] = useToast();
  const load = () =>
    api<ItemType[]>('/admin/item-types')
      .then((t) => (setTypes(t), setError(null)))
      .catch(setError);
  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Stolen-item types</h1>
          <p className="lede">What citizens can register, report stolen and check before buying. Each type sets its unique identifier, how it is checked and the proof owners give.</p>
        </div>
        <button className="btn signal" type="button" onClick={() => setEdit('new')}>
          Add item type
        </button>
      </div>
      {error && (
        <div className="banner critical" role="alert">
          <strong>Could not load item types</strong>
          {error.message}
        </div>
      )}
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {!types && !error ? (
          <div style={{ padding: 20 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" />
            ))}
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Unique identifier</th>
                <th>Proof owners give</th>
                <th>In use</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {types?.map((t) => (
                <tr key={t.code}>
                  <td>
                    <strong>{t.label}</strong>
                    <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>{t.code}</div>
                  </td>
                  <td>
                    {t.identifierLabel}
                    <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>{ruleText(t.rule)}</div>
                  </td>
                  <td>{t.documents.length ? t.documents.map((d) => `${d.label}${d.required ? '' : ' (optional)'}`).join(', ') : 'None'}</td>
                  <td>
                    {t.items} registered
                    <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>{t.openCases} stolen now</div>
                  </td>
                  <td>
                    <span className={`chip ${t.active ? 'success' : 'neutral'}`}>{t.active ? 'In the app' : 'Hidden'}</span>
                  </td>
                  <td>
                    <button className="btn" type="button" onClick={() => setEdit(t)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {edit && (
        <TypeSheet
          initial={edit === 'new' ? null : edit}
          onClose={() => setEdit(null)}
          onDone={(m) => {
            setEdit(null);
            setToast(m);
            void load();
          }}
        />
      )}
      {toast}
    </>
  );
}

function TypeSheet({ initial, onClose, onDone }: { initial: ItemType | null; onClose: () => void; onDone: (m: string) => void }) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [code, setCode] = useState(initial?.code ?? '');
  const [codeTouched, setCodeTouched] = useState(!!initial);
  const [icon, setIcon] = useState(initial?.icon ?? 'other');
  const [idLabel, setIdLabel] = useState(initial?.identifierLabel ?? '');
  const [hint, setHint] = useState(initial?.identifierHint ?? '');
  const [min, setMin] = useState(String(initial?.rule.minLength ?? 6));
  const [max, setMax] = useState(String(initial?.rule.maxLength ?? 20));
  const [charset, setCharset] = useState<IdentifierRule['charset']>(initial?.rule.charset ?? 'alnum');
  const [checksum, setChecksum] = useState<IdentifierRule['checksum']>(initial?.rule.checksum ?? 'none');
  const [pattern, setPattern] = useState(initial?.rule.pattern ?? '');
  const [docs, setDocs] = useState<ItemDocument[]>(initial?.documents ?? [{ code: 'receipt', label: 'Receipt or proof of purchase', required: true }]);
  const [active, setActive] = useState(initial?.active ?? true);
  const [sample, setSample] = useState('');
  const [tried, setTried] = useState(false);
  const s = useSubmit();

  const rule: IdentifierRule = { minLength: Number(min), maxLength: Number(max), charset, checksum, pattern: pattern.trim() || null };
  const ruleErr = checkRule(rule);
  const errs: Record<string, string | null> = {
    label: label.trim().length < 2 ? 'Name the item type.' : null,
    code: !initial && !/^[a-z][a-z0-9_]{1,30}$/.test(code) ? 'Use lower-case letters, digits and _ (e.g. motorbike).' : null,
    idLabel: idLabel.trim().length < 2 ? 'Name its unique identifier (e.g. Frame number).' : null,
    rule: ruleErr,
    docs: docs.some((d) => d.label.trim().length < 2) ? 'Name each document.' : null,
  };
  const bad = Object.values(errs).some(Boolean);
  const test = sample.trim() && !ruleErr ? validateIdentifier({ identifierLabel: idLabel || 'identifier', rule }, sample) : null;

  return (
    <Sheet
      open
      wide
      title={initial ? `Edit ${initial.label}` : 'Add an item type'}
      description="Changes reach the app at once. Hiding a type keeps its registered items and stolen reports; buyers can no longer pick it."
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
              if (bad) return focusFirstError();
              const body = { label: label.trim(), icon, identifierLabel: idLabel.trim(), identifierHint: hint.trim(), rule, documents: docs.map((d) => ({ ...d, label: d.label.trim() })), active, sort: initial?.sort ?? 100 };
              void s.run(async () => {
                if (initial) await api(`/admin/item-types/${initial.code}`, { method: 'PUT', body: JSON.stringify(body) });
                else await api('/admin/item-types', { method: 'POST', body: JSON.stringify({ ...body, code }) });
                onDone(initial ? 'Item type saved.' : `${label.trim()} added. Citizens can use it now.`);
              });
            }}
          >
            {s.busy ? 'Saving…' : initial ? 'Save' : 'Add item type'}
          </button>
        </>
      }
    >
      <ErrorBox error={s.error} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label className="field" data-invalid={tried && !!errs.label}>
          <span>Name</span>
          <input
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
              if (!codeTouched) setCode(slug(e.target.value));
            }}
            placeholder="e.g. Motorbike"
            maxLength={40}
            aria-invalid={tried && !!errs.label}
          />
          {tried && errs.label && <span className="field-error">{errs.label}</span>}
        </label>
        <label className="field" data-invalid={tried && !!errs.code}>
          <span>Code</span>
          <input value={code} disabled={!!initial} onChange={(e) => (setCode(e.target.value), setCodeTouched(true))} maxLength={31} aria-invalid={tried && !!errs.code} />
          {tried && errs.code && <span className="field-error">{errs.code}</span>}
        </label>
        <label className="field">
          <span>Icon</span>
          <select value={icon} onChange={(e) => setIcon(e.target.value)}>
            {ICONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ alignSelf: 'end' }}>
          <span>In the app</span>
          <select value={active ? 'yes' : 'no'} onChange={(e) => setActive(e.target.value === 'yes')}>
            <option value="yes">Shown to citizens</option>
            <option value="no">Hidden</option>
          </select>
        </label>
      </div>

      <h3 style={{ fontSize: 15, margin: '8px 0' }}>Unique identifier</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label className="field" data-invalid={tried && !!errs.idLabel}>
          <span>What it is called</span>
          <input value={idLabel} onChange={(e) => setIdLabel(e.target.value)} placeholder="e.g. Frame number" maxLength={40} aria-invalid={tried && !!errs.idLabel} />
          {tried && errs.idLabel && <span className="field-error">{errs.idLabel}</span>}
        </label>
        <label className="field">
          <span>Where to find it (shown under the field)</span>
          <input value={hint} onChange={(e) => setHint(e.target.value)} maxLength={200} placeholder="e.g. Stamped on the frame by the handlebars." />
        </label>
        <label className="field">
          <span>Shortest</span>
          <input type="number" min={3} max={64} value={min} onChange={(e) => setMin(e.target.value)} />
        </label>
        <label className="field">
          <span>Longest</span>
          <input type="number" min={3} max={64} value={max} onChange={(e) => setMax(e.target.value)} />
        </label>
        <label className="field">
          <span>Characters</span>
          <select value={charset} onChange={(e) => setCharset(e.target.value as IdentifierRule['charset'])}>
            {Object.entries(CHARSET).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Check digit</span>
          <select value={checksum} onChange={(e) => setChecksum(e.target.value as IdentifierRule['checksum'])}>
            {Object.entries(CHECKSUM).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ gridColumn: '1 / -1' }}>
          <span>Extra pattern (optional, regular expression on the cleaned value)</span>
          <input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="e.g. ^[A-Z]{3}" maxLength={200} style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)' }} />
        </label>
      </div>
      {tried && errs.rule && (
        <div className="banner critical" role="alert" data-invalid="true">
          {errs.rule}
        </div>
      )}
      {!tried && ruleErr && <p className="field-error">{ruleErr}</p>}
      <label className="field" data-invalid={!!test && !test.ok}>
        <span>Try an identifier</span>
        <input value={sample} onChange={(e) => setSample(e.target.value)} placeholder="Type one to see what citizens are told" style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)' }} />
        {test && (test.ok ? <span style={{ color: 'var(--color-success-text)', fontSize: 13 }}>Accepted as {test.value}</span> : <span className="field-error">{test.message}</span>)}
      </label>

      <h3 style={{ fontSize: 15, margin: '8px 0' }}>Proof the owner gives</h3>
      {docs.map((d, i) => (
        <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 8 }}>
          <label className="field" style={{ flex: 1, margin: 0 }} data-invalid={tried && d.label.trim().length < 2}>
            <span>Document {i + 1}</span>
            <input
              value={d.label}
              onChange={(e) => setDocs((xs) => xs.map((x, j) => (j === i ? { ...x, label: e.target.value, code: initial?.documents.some((o) => o.code === x.code) ? x.code : slug(e.target.value) || `doc_${i + 1}` } : x)))}
              placeholder="e.g. Vehicle papers"
              maxLength={80}
            />
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', paddingBottom: 10, whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={d.required} onChange={(e) => setDocs((xs) => xs.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} /> Required
          </label>
          <button className="btn" type="button" onClick={() => setDocs((xs) => xs.filter((_, j) => j !== i))} aria-label={`Remove document ${i + 1}`}>
            Remove
          </button>
        </div>
      ))}
      {tried && errs.docs && <p className="field-error">{errs.docs}</p>}
      {docs.length < 6 && (
        <button className="btn" type="button" onClick={() => setDocs((xs) => [...xs, { code: `doc_${xs.length + 1}`, label: '', required: false }])}>
          Add a document
        </button>
      )}
    </Sheet>
  );
}
