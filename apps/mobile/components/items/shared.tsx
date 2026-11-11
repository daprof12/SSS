'use client';
// Pieces shared by the stolen-item screens: item types from the API, the identifier field (checked
// on the phone with the same rules as the server), and the proof-document picker.
import { validateIdentifier, type ItemDocument, type ItemTypeDef } from '@erp/domain';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { api, haptic } from '@/lib/client';
import { uploadFile, type OwnerType } from '@/components/reports/Attach';

export type ItemType = ItemTypeDef;

export function useItemTypes() {
  const [types, setTypes] = useState<ItemType[] | null>(null);
  useEffect(() => {
    api<ItemType[]>('/item-types')
      .then(setTypes)
      .catch(() => setTypes([]));
  }, []);
  return types;
}

/** Car, phone, laptop… as tiles. */
export function TypeTiles({ types, value, onChange, label = 'What kind of item?' }: { types: ItemType[] | null; value: string | null; onChange: (t: ItemType) => void; label?: string }) {
  return (
    <>
      <p className="section-label">{label}</p>
      {!types && <div className="skeleton" style={{ height: 84 }} />}
      <div className="tiles" role="radiogroup" aria-label={label} style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        {types?.map((t) => (
          <button key={t.code} type="button" role="radio" aria-checked={value === t.code} aria-pressed={value === t.code} className="tile" onClick={() => onChange(t)}>
            <Icon name={t.icon} size={28} />
            {t.label}
          </button>
        ))}
      </div>
    </>
  );
}

/** The item's unique identifier (IMEI, VIN, serial number). Says what is wrong as soon as the person stops typing. */
export function IdentifierField({ type, value, onChange, error, autoFocus }: { type: ItemType; value: string; onChange: (v: string) => void; error?: string; autoFocus?: boolean }) {
  const [touched, setTouched] = useState(false);
  const check = value.trim() ? validateIdentifier(type, value) : null;
  const shown = error ?? (touched && check && !check.ok ? check.message : undefined);
  const digits = type.rule.charset === 'digits';
  return (
    <label className="field" data-invalid={!!shown}>
      <span>{type.identifierLabel}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setTouched(true)}
        inputMode={digits ? 'numeric' : 'text'}
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        maxLength={type.rule.maxLength + 10}
        aria-invalid={!!shown}
        placeholder={digits ? '0'.repeat(type.rule.maxLength) : type.identifierLabel}
        style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', letterSpacing: '0.04em' }}
      />
      <span className="muted">{check?.ok ? <><Icon name="check" size={14} /> Looks right</> : type.identifierHint}</span>
      {shown && <span className="field-error">{shown}</span>}
    </label>
  );
}

const DOC_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX = 10 * 1024 * 1024;

/** Picked proof documents, by the type's document code. They upload once the item or report exists. */
export function useDocs() {
  const [files, setFiles] = useState<Record<string, File>>({});
  return {
    files,
    set: (code: string, f: File | null) => setFiles((x) => {
      const n = { ...x };
      if (f) n[code] = f;
      else delete n[code];
      return n;
    }),
    /** Uploads each picked document; returns how many failed. */
    async upload(ownerType: OwnerType, ownerId: string) {
      let failed = 0;
      for (const [code, f] of Object.entries(files)) {
        try {
          await uploadFile(ownerType, ownerId, f, code);
        } catch {
          failed++;
        }
      }
      return failed;
    },
  };
}

/** One row per document the type asks for: a receipt, the vehicle licence. Photo or PDF. */
export function DocPicker({ docs, picked, have = [], optionalAll, disabled }: { docs: ItemDocument[]; picked: ReturnType<typeof useDocs>; have?: string[]; optionalAll?: boolean; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!docs.length) return null;
  return (
    <div className="field" data-invalid={!!err}>
      <span>Proof of ownership{optionalAll ? ' (optional)' : ''}</span>
      <div className="list">
        {docs.map((d) => {
          const f = picked.files[d.code];
          const done = have.includes(d.code);
          return (
            <div key={d.code} className="row" style={{ cursor: 'default' }}>
              <span className="icon">
                <Icon name={done || f ? 'check' : 'article'} />
              </span>
              <span className="grow">
                <strong>{d.label}</strong>
                <span className="sub">{f ? f.name : done ? 'Added' : d.required && !optionalAll ? 'Needed to prove it is yours' : 'Optional'}</span>
              </span>
              {f ? (
                <button type="button" className="link-btn" disabled={disabled} onClick={() => picked.set(d.code, null)}>
                  Remove
                </button>
              ) : (
                <button
                  type="button"
                  className="link-btn"
                  disabled={disabled}
                  onClick={() => {
                    setTarget(d.code);
                    setErr(null);
                    input.current?.click();
                  }}
                >
                  {done ? 'Replace' : 'Add'}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <input
        ref={input}
        type="file"
        accept={DOC_TYPES.join(',')}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f || !target) return;
          if (!DOC_TYPES.includes(f.type) || f.size > MAX) return setErr('Use a photo or a PDF up to 10 MB.');
          haptic(10);
          picked.set(target, f);
        }}
      />
      {err && <span className="field-error">{err}</span>}
      <span className="muted">A photo or PDF of each, up to 10 MB. Only you and the police on a case see them.</span>
    </div>
  );
}

export const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const lagosToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
export const chipTone = (state: string) => (['recovered', 'returned'].includes(state) ? 'success' : ['investigating', 'located'].includes(state) ? 'info' : state === 'reported' ? 'warning' : 'neutral');

/** Make and model examples for each built-in type. */
export const examples = (code: string | undefined) =>
  code === 'car' ? ['e.g. Toyota', 'e.g. Corolla 2015'] : code === 'laptop' ? ['e.g. HP', 'e.g. EliteBook 840'] : code === 'phone' ? ['e.g. Tecno', 'e.g. Camon 20'] : ['Make', 'Model'];
