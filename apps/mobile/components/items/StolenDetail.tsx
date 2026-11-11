'use client';

import { Sheet } from '@erp/web-ui/Sheet';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api, ApiError } from '@/lib/client';
import { AddFiles, Attachments } from '@/components/reports/Attach';
import { day } from './shared';

interface Case {
  publicNo: string;
  itemId: string;
  name: string;
  typeLabel: string;
  identifierLabel: string;
  identifier: string;
  agency: string;
  state: string;
  status: { chip: string; tone: string; line: string };
  stolenOn: string;
  circumstances: string | null;
  policeReportNo: string | null;
  place: string;
  steps: Array<{ key: string; label: string; done: boolean; at: string | null }>;
  matches: { count: number; last: { at: string; area: string | null } | null };
  timeline: Array<{ label: string; note: string | null; at: string }>;
  documents: Array<{ code: string; label: string; required: boolean; provided: boolean }>;
  canWithdraw: boolean;
  canAddFiles: boolean;
}

/** The owner follows the recovery: steps, buyer checks (never who), police updates. */
export function StolenDetail({ id }: { id: string }) {
  const params = useSearchParams();
  const [k, setK] = useState<Case | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useToast();
  const [sheet, setSheet] = useState<'withdraw' | 'files' | null>(null);
  const [refresh, setRefresh] = useState(0);

  const load = useCallback(() => api<Case>(`/stolen-reports/${id}`).then(setK).catch((e: ApiError) => setErr(e.message)), [id]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (params.get('sent') === '1') setToast(Number(params.get('files') ?? 0) ? 'Reported, but some files did not upload. Add them again below.' : 'Reported to the police.');
  }, [params, setToast]);

  if (err) return <main className="app bare"><Header back="/items" /><div className="card empty"><strong>{err}</strong></div></main>;
  if (!k) return <main className="app bare">{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 90 }} />)}</main>;

  return (
    <main className="app bare">
      <Header title={k.name} back="/items">
        <span className={`chip ${k.status.tone}`}>{k.status.chip}</span>
      </Header>

      {k.matches.count > 0 && (
        <div className="banner info" role="status" style={{ display: 'flex', gap: 12 }}>
          <Icon name="search" />
          <span>
            <strong>
              {k.matches.count === 1 ? 'Someone checked it before buying' : `Checked ${k.matches.count} times by buyers`}
            </strong>
            Last on {day(k.matches.last!.at)}
            {k.matches.last!.area ? ` near ${k.matches.last!.area}` : ''}. The police have the details. Do not go there yourself.
          </span>
        </div>
      )}

      <div className="card">
        <strong style={{ display: 'block' }}>Stolen-item report {k.publicNo}</strong>
        <span className="muted" style={{ fontSize: 'var(--text-sm)', wordBreak: 'break-all' }}>
          {k.typeLabel} · {k.identifierLabel} {k.identifier}
        </span>
        <p style={{ margin: '8px 0 0' }}>{k.status.line}</p>
      </div>

      {k.steps.length > 0 && (
        <div className="card">
          <ol className="steps" style={{ gridTemplateColumns: '1fr', margin: 0 }} aria-label="Recovery">
            {k.steps.map((s, i) => {
              // The step after the last one reached is the one in progress (a step can be skipped).
              const now = i === k.steps.map((x) => x.done).lastIndexOf(true) + 1;
              return (
                <li key={s.key} className={s.done ? 'done' : now ? 'now' : ''}>
                  <i aria-hidden />
                  <span style={{ flex: 1 }}>{s.label}</span>
                  <span className="muted">{s.at ? day(s.at) : ''}</span>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      <div className="card">
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px' }}>
          <dt className="muted">Stolen</dt>
          <dd style={{ margin: 0 }}>{day(k.stolenOn)}</dd>
          <dt className="muted">Where</dt>
          <dd style={{ margin: 0 }}>{k.place}</dd>
          <dt className="muted">Sent to</dt>
          <dd style={{ margin: 0 }}>{k.agency}</dd>
          {k.policeReportNo && (
            <>
              <dt className="muted">Police report</dt>
              <dd style={{ margin: 0 }}>{k.policeReportNo}</dd>
            </>
          )}
        </dl>
        {k.circumstances && <p style={{ margin: '8px 0 0' }}>{k.circumstances}</p>}
      </div>

      {k.documents.some((d) => d.required && !d.provided) && (
        <div className="banner warning">
          <strong>Add your proof of ownership</strong>
          {k.documents.filter((d) => d.required && !d.provided).map((d) => d.label).join(', ')}. The police need it to return the item to you.
        </div>
      )}

      <p className="section-label">Updates</p>
      <div className="list">
        {k.timeline
          .slice()
          .reverse()
          .map((e, i) => (
            <div key={i} className="row" style={{ cursor: 'default' }}>
              <span className="grow">
                <strong>{e.label}</strong>
                {e.note && <span className="sub">{e.note}</span>}
              </span>
              <span className="muted">{day(e.at)}</span>
            </div>
          ))}
      </div>

      <Attachments ownerType="stolen_case" ownerId={id} refreshKey={refresh} title="Photos and documents you sent" />
      {k.canAddFiles && (
        <button className="btn block signal" type="button" onClick={() => setSheet('files')} style={{ marginTop: 8 }}>
          Add photos or a receipt
        </button>
      )}
      {k.canWithdraw && (
        <button className="link-btn" type="button" onClick={() => setSheet('withdraw')} style={{ display: 'block', margin: '12px auto 0' }}>
          I have it back
        </button>
      )}

      <Sheet open={sheet === 'files'} title="Add photos or a receipt" onClose={() => setSheet(null)} footer={null}>
        <AddFiles
          ownerType="stolen_case"
          ownerId={id}
          cta="Send"
          onDone={() => {
            setSheet(null);
            setRefresh((n) => n + 1);
            setToast('Sent to the police.');
          }}
        />
      </Sheet>
      <Sheet
        open={sheet === 'withdraw'}
        title="Withdraw this report?"
        description={`${k.agency} stops looking for it and buyers are no longer warned.`}
        onClose={() => setSheet(null)}
        footer={
          <>
            <button
              className="btn"
              type="button"
              onClick={() => withdraw('mistake')}
            >
              Reported by mistake
            </button>
            <button className="btn primary" type="button" onClick={() => withdraw('found')}>
              I got it back
            </button>
          </>
        }
      >
        {null}
      </Sheet>
      <Toast msg={toast} />
    </main>
  );

  async function withdraw(reason: 'found' | 'mistake') {
    try {
      await api(`/stolen-reports/${id}/withdraw`, { method: 'POST', body: JSON.stringify({ reason }) });
      setToast(reason === 'found' ? 'Glad you have it back.' : 'Report withdrawn.');
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not withdraw.');
    }
    setSheet(null);
    void load();
  }
}
