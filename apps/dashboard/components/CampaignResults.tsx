'use client';
// Board "Admin campaign results" (also used by agency messaging): who was reached by which channel, why some were not, the
// fallback from push to SMS, and the cost. Waiting campaigns are approved here by a second admin.
import { LinkButton } from '@erp/web-ui/LinkButton';
import { api, ApiError, downloadFile } from '@erp/web-ui/api';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/Agency';
import { naira } from '@/components/Dash';

interface Result {
  id: string;
  title: string;
  body: string;
  kind: string;
  state: string;
  channels: string[];
  by: string;
  sentAt: string | null;
  sendAt: string | null;
  canApprove: boolean;
  stats: { people: number; reached: number; reachedPct: number; readPct: number; failed: number; costKobo: number };
  channelsTable: { channel: string; sent: number; delivered: number; read: number | null; failed: number }[];
  reasons: { code: string; n: number }[];
  fallback: { pushOnly: number; movedToSms: number; movedToWhatsapp: number; nothing: number };
  cost: { smsKobo: number; whatsappKobo: number; totalKobo: number };
  approvedBy: { name: string } | null;
}
const REASON: Record<string, string> = {
  number_not_valid: 'Number not valid',
  phone_off: 'Phone off, retried',
  opted_out: 'Opted out of messages',
  whatsapp_not_opted_in: 'WhatsApp not opted in',
  dnd: 'Do-not-disturb list',
  no_channel: 'No way to reach them',
};
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Results for one campaign, on the platform or an agency's messaging page. */
export function CampaignResults({ id, apiBase, backHref }: { id: string; apiBase: string; backHref: string }) {
  const router = useRouter();
  const [r, setR] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useToast();
  const load = useCallback(() => {
    api<Result>(`${apiBase}/campaigns/${id}`)
      .then(setR)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the campaign.'));
  }, [id]);
  useEffect(load, [load]);
  const act = async (path: 'approve' | 'resend' | 'duplicate') => {
    setBusy(true);
    try {
      const x = await api<{ id?: string; message: string }>(`${apiBase}/campaigns/${id}/${path}`, { method: 'POST', body: '{}' });
      setToast(x.message);
      if (path === 'duplicate' && x.id) router.push(backHref);
      else load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not do that.');
    } finally {
      setBusy(false);
    }
  };
  const Row = ({ k, v, tone }: { k: string; v: React.ReactNode; tone?: string }) => (
    <div className="row">
      <span>{k}</span>
      <strong style={{ color: tone }}>{v}</strong>
    </div>
  );
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>{r ? r.title : 'Campaign'}</h1>
          <p className="lede">
            {r
              ? r.sentAt
                ? `Sent ${when(r.sentAt)} by ${r.by}, audience ${r.stats.people} people`
                : r.state === 'awaiting_approval'
                  ? `Waiting for a second admin to approve. Written by ${r.by}.`
                  : r.state === 'scheduled'
                    ? `Scheduled for ${when(r.sendAt!)}`
                    : `Draft by ${r.by}`
              : ' '}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <LinkButton className="btn" href={backHref}>
            Back to campaigns
          </LinkButton>
          <button className="btn" type="button" disabled={!r?.sentAt} onClick={() => downloadFile(`${apiBase}/campaigns/${id}/results.csv`, 'campaign-results.csv').catch((e) => setToast(e.message))}>
            Export results
          </button>
        </div>
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      {r?.canApprove && (
        <div className="banner warning" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <span>
            “{r.body}” goes to {r.channels.join(', ')}. Approving sends it now.
          </span>
          <button className="btn primary" type="button" disabled={busy} onClick={() => act('approve')}>
            Approve and send
          </button>
        </div>
      )}
      {r && (
        <>
          <div className="stats">
            <div className="stat">
              <span>Reached</span>
              <strong className="success">{r.stats.reachedPct}%</strong>
              <small>
                {r.stats.reached} of {r.stats.people}
              </small>
            </div>
            <div className="stat">
              <span>Read</span>
              <strong>{r.stats.readPct}%</strong>
              <small>Push and WhatsApp</small>
            </div>
            <div className="stat">
              <span>Failed</span>
              <strong className="critical">{r.stats.failed}</strong>
              <small>See reasons</small>
            </div>
            <div className="stat">
              <span>Cost</span>
              <strong className="info">{naira(r.stats.costKobo)}</strong>
              <small>All channels</small>
            </div>
          </div>
          <div className="grid two" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(280px, 2fr)' }}>
            <section className="card" style={{ padding: 0, overflowX: 'auto' }} aria-labelledby="dc">
              <h2 id="dc" style={{ margin: 0, padding: '16px 16px 0' }}>
                Delivery by channel
              </h2>
              <table className="table">
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th>Sent</th>
                    <th>Delivered</th>
                    <th>Read or clicked</th>
                    <th>Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {r.channelsTable.map((c) => (
                    <tr key={c.channel}>
                      <td>
                        <strong>{c.channel}</strong>
                      </td>
                      <td>{c.sent}</td>
                      <td>{c.delivered}</td>
                      <td>{c.read ?? 'n/a'}</td>
                      <td style={{ color: c.failed ? 'var(--color-emergency-text)' : undefined }}>{c.failed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="card" aria-labelledby="wf">
              <h2 id="wf" style={{ marginTop: 0 }}>
                Why messages failed
              </h2>
              {r.reasons.map((x) => (
                <Row key={x.code} k={REASON[x.code] ?? x.code} v={x.n} />
              ))}
            </section>
          </div>
          <div className="grid two">
            <section className="card" aria-labelledby="fb">
              <h2 id="fb" style={{ marginTop: 0 }}>
                Fallback result
              </h2>
              <Row k="Push read, no SMS needed" v={r.fallback.pushOnly} />
              <Row k="Moved to SMS after 10 min" v={r.fallback.movedToSms} />
              <Row k="Moved to WhatsApp" v={r.fallback.movedToWhatsapp} />
              <Row k="Reached by nothing" v={r.fallback.nothing} tone={r.fallback.nothing ? 'var(--color-emergency-text)' : undefined} />
              {r.fallback.nothing > 0 && (
                <div className="banner warning" style={{ margin: '8px 0 0' }}>
                  <strong style={{ display: 'block' }}>{r.fallback.nothing} people were not reached</strong>
                  Their phone numbers need checking. Send them a follow-up by SMS.
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
                <button className="btn signal" type="button" disabled={busy || !r.sentAt || !r.fallback.nothing} onClick={() => act('resend')}>
                  Resend to unreached
                </button>
                <button className="btn" type="button" disabled={busy} onClick={() => act('duplicate')}>
                  Duplicate
                </button>
              </div>
            </section>
            <section className="card" aria-labelledby="co">
              <h2 id="co" style={{ marginTop: 0 }}>
                Cost
              </h2>
              <Row k="SMS" v={naira(r.cost.smsKobo)} />
              <Row k="WhatsApp" v={naira(r.cost.whatsappKobo)} />
              <Row k="Total" v={naira(r.cost.totalKobo)} tone="var(--color-signal)" />
              <Row k="Approved by" v={r.approvedBy ? r.approvedBy.name : 'Not needed'} />
            </section>
          </div>
        </>
      )}
    </>
  );
}
