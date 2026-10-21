'use client';
// Boards "Admin messaging CRM" and "Agency messaging CRM": send push, SMS or WhatsApp to any user, officer or staff member.
// Marketing goes only to people who opted in; safety notices go to everyone in the area. Large
// sends need a second platform admin.
import { api, ApiError } from '@erp/web-ui/api';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useToast } from '@/components/Agency';
import { naira } from '@/components/Dash';
import { LocationFilter, type LocFilter } from '@/components/LocationFilter';

type Who = 'citizen' | 'officer' | 'head' | 'agency_admin';
type Channel = 'push' | 'sms' | 'whatsapp';
interface Size {
  people: number;
  noPush: number;
  noPhone: number;
  optedOut: number;
  cost: { smsKobo: number; whatsappKobo: number };
  needsApproval: boolean;
}
interface Campaign {
  id: string;
  title: string;
  kind: string;
  state: string;
  channels: string[];
  sendAt: string | null;
  sentAt: string | null;
  by: string;
  people: number;
  reachedPct: number | null;
}
const WHO: [Who, string][] = [
  ['citizen', 'Citizens'],
  ['officer', 'Officers'],
  ['head', 'Station heads'],
  ['agency_admin', 'Agency admins'],
];
const STATE: Record<string, [string, string]> = {
  draft: ['Draft', 'var(--color-text-secondary)'],
  awaiting_approval: ['Waiting for approval', 'var(--color-warning-text)'],
  scheduled: ['Scheduled', 'var(--color-info-text, var(--color-signal))'],
  sent: ['Sent', 'var(--color-success-text)'],
  cancelled: ['Cancelled', 'var(--color-text-secondary)'],
};
const LANGS: [string, string][] = [
  ['en', 'English'],
  ['pcm', 'Pidgin'],
  ['yo', 'Yoruba'],
  ['ha', 'Hausa'],
  ['ig', 'Igbo'],
];

/** The messaging board for the platform (`/admin/crm`) or one agency (`/agencies/:id/crm`). */
export function CrmBoard({ apiBase, detailBase, agencyName }: { apiBase: string; detailBase: string; agencyName?: string }) {
  const [tab, setTab] = useState<'compose' | 'campaigns' | 'consent'>('compose');
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Messaging</h1>
          <p className="lede">{agencyName ? `Send push, SMS or WhatsApp to ${agencyName}'s staff and the people living in its stations' areas.` : 'Send push, SMS or WhatsApp to any user, officer or staff member.'}</p>
        </div>
      </div>
      <div className="segmented tabs" role="tablist">
        {(
          [
            ['compose', 'Compose'],
            ['campaigns', 'Campaigns'],
            ...(agencyName ? [] : ([['consent', 'Consent and opt-outs']] as const)),
          ] as const
        ).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'compose' ? <Compose apiBase={apiBase} detailBase={detailBase} agency={!!agencyName} /> : tab === 'campaigns' ? <Campaigns apiBase={apiBase} detailBase={detailBase} /> : <Consent />}
    </>
  );
}

function Compose({ apiBase, detailBase, agency }: { apiBase: string; detailBase: string; agency: boolean }) {
  const router = useRouter();
  const [loc, setLoc] = useState<LocFilter>({});
  const [who, setWho] = useState<Who[]>(['citizen']);
  const [agencyId, setAgencyId] = useState('');
  const [agencies, setAgencies] = useState<{ id: string; name: string }[]>([]);
  const [kind, setKind] = useState<'marketing' | 'safety'>('safety');
  const [urgent, setUrgent] = useState(false);
  const [channels, setChannels] = useState<Channel[]>(['push', 'sms']);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [langs, setLangs] = useState<string[]>(['en']);
  const [link, setLink] = useState('');
  const [sendAt, setSendAt] = useState('');
  const [size, setSize] = useState<Size | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useToast();
  useEffect(() => {
    if (agency) return;
    api<{ agencies: { id: string; name: string }[] }>('/admin/agencies-board')
      .then((b) => setAgencies(b.agencies))
      .catch(() => setAgencies([]));
  }, [agency]);
  const audience = agency ? { who, ...loc } : { who, agencyId: agencyId || undefined, ...loc };
  const aKey = JSON.stringify([audience, kind, channels]);
  useEffect(() => {
    const t = setTimeout(() => {
      api<Size>(`${apiBase}/audience`, { method: 'POST', body: JSON.stringify({ ...audience, kind, channels }) })
        .then(setSize)
        .catch(() => setSize(null));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aKey]);
  const over = channels.includes('sms') ? body.length - 160 : 0;
  const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);
  const submit = async (action: 'draft' | 'request_approval' | 'schedule' | 'send' | 'test') => {
    setBusy(true);
    setErr(null);
    setFields({});
    try {
      const r = await api<{ id?: string; message: string }>(`${apiBase}/campaigns`, {
        method: 'POST',
        body: JSON.stringify({ action, title: title.trim(), body: body.trim(), kind, urgent, audience, channels, languages: langs, link: link.trim() || undefined, sendAt: action === 'schedule' && sendAt ? new Date(sendAt).toISOString() : undefined }),
      });
      setToast(r.message);
      if (r.id && action !== 'draft') router.push(`${detailBase}/${r.id}`);
    } catch (e) {
      if (e instanceof ApiError) {
        setErr(e.message);
        setFields(Object.fromEntries((e.fields ?? []).map((f) => [f.field, f.message])));
      } else setErr('Could not send. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const smsK = size?.cost.smsKobo ?? 0;
  const waK = size?.cost.whatsappKobo ?? 0;
  return (
    <>
      {toast}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', margin: '0 0 12px', flexWrap: 'wrap' }}>
        <button className="btn" type="button" disabled={busy || !title || !body} onClick={() => submit('test')}>
          Send test to me
        </button>
        <button className="btn" type="button" disabled={busy || !title || !body || !sendAt} onClick={() => submit('schedule')} title={sendAt ? undefined : 'Choose a send time first'}>
          Schedule
        </button>
        <button className="btn primary" type="button" disabled={busy || !title || !body || over > 0 || size?.needsApproval} onClick={() => submit('send')}>
          Send
        </button>
      </div>
      {err && (
        <div className="banner critical" role="alert">
          {err}
        </div>
      )}
      <div className="grid two">
        <section className="card" aria-labelledby="who">
          <h2 id="who" style={{ marginTop: 0 }}>
            1. Who gets it
          </h2>
          <LocationFilter value={loc} onChange={setLoc} />
          <fieldset className="field" style={{ border: 0, padding: 0 }}>
            <legend>Who</legend>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {WHO.map(([k, l]) => (
                <button key={k} type="button" className="chip" aria-pressed={who.includes(k)} onClick={() => setWho(toggle(who, k))} style={{ cursor: 'pointer', outline: who.includes(k) ? '2px solid var(--color-signal)' : undefined }}>
                  {l}
                </button>
              ))}
            </div>
            {fields.who && <span className="field-error">{fields.who}</span>}
          </fieldset>
          {!agency && (
          <label className="field">
            <span>Agency or station</span>
            <select value={agencyId} onChange={(e) => setAgencyId(e.target.value)}>
              <option value="">All agencies</option>
              {agencies.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          )}
          <div className="banner info" style={{ margin: 0 }}>
            <strong style={{ display: 'block' }}>Audience size</strong>
            {size ? `${size.people} ${size.people === 1 ? 'person matches' : 'people match'}. ${size.noPush} have no push, ${size.noPhone} have no phone number.${size.optedOut ? ` ${size.optedOut} opted out of marketing.` : ''}` : 'Counting…'}
          </div>
          {size?.needsApproval && (
            <div className="banner warning" style={{ margin: '8px 0 0' }}>
              This is a large send. Request approval from a second admin.
            </div>
          )}
        </section>
        <section className="card" aria-labelledby="how">
          <h2 id="how" style={{ marginTop: 0 }}>
            2. How it is sent
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {(
              [
                ['push', 'Push', 'Free, instant. In-app inbox too'],
                ['sms', 'SMS', 'Used if push is not read in 10 min'],
                ['whatsapp', 'WhatsApp', 'Only people who opted in'],
              ] as [Channel, string, string][]
            ).map(([k, l, d]) => (
              <button key={k} type="button" className="choice-card" aria-pressed={channels.includes(k)} onClick={() => setChannels(toggle(channels, k))}>
                <strong>{l}</strong>
                <div className="muted" style={{ fontSize: 13 }}>
                  {d}
                </div>
              </button>
            ))}
          </div>
          {fields.channels && <span className="field-error">{fields.channels}</span>}
          <div className="row">
            <span className="muted">Fallback order</span>
            <strong>Push, then SMS, then WhatsApp</strong>
          </div>
          <label className="field">
            <span>Kind</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as 'marketing' | 'safety')}>
              <option value="safety">Safety notice (goes to everyone in the area)</option>
              <option value="marketing">Marketing (only people who opted in)</option>
            </select>
          </label>
          <label className="field">
            <span>Send time</span>
            <input type="datetime-local" value={sendAt} onChange={(e) => setSendAt(e.target.value)} />
            <small className="muted">Leave empty to send now. Quiet hours 22:00 to 06:00 unless marked urgent.</small>
          </label>
          {fields.sendAt && <span className="field-error">{fields.sendAt}</span>}
          <div className="row">
            <div className="label">
              <strong>Emergency alert</strong>
              <span>Ignores quiet hours. Only a platform admin or station head can mark a message urgent.</span>
            </div>
            <button className="toggle" type="button" role="switch" aria-checked={urgent} aria-label="Urgent" onClick={() => setUrgent(!urgent)} />
          </div>
        </section>
      </div>
      <section className="card" aria-labelledby="msg">
        <h2 id="msg" style={{ marginTop: 0 }}>
          3. Message
        </h2>
        <label className="field" data-invalid={!!fields.title}>
          <span>Title</span>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Road works on Maple Road" />
          {fields.title && <span className="field-error">{fields.title}</span>}
        </label>
        <label className="field" data-invalid={over > 0 || !!fields.body}>
          <span>Message{channels.includes('sms') ? ', 160 characters for SMS' : ''}</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={1000} />
          <small className={over > 0 ? 'field-error' : 'muted'}>
            {fields.body ?? (over > 0 ? `SMS must be 160 characters or fewer, now ${over} over.` : channels.includes('sms') ? `${160 - body.length} left for SMS` : `${body.length} characters`)}
          </small>
        </label>
        <fieldset className="field" style={{ border: 0, padding: 0 }}>
          <legend>Language</legend>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {LANGS.map(([k, l]) => (
              <button key={k} type="button" className="chip" aria-pressed={langs.includes(k)} disabled={k === 'en'} onClick={() => setLangs(toggle(langs, k))} style={{ cursor: 'pointer', outline: langs.includes(k) ? '2px solid var(--color-signal)' : undefined }}>
                {l}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="field">
          <span>Link or action (optional)</span>
          <input type="text" value={link} onChange={(e) => setLink(e.target.value)} placeholder="/learn" />
        </label>
      </section>
      <div className="grid two">
        <section className="card" aria-labelledby="pv">
          <h2 id="pv" style={{ marginTop: 0 }}>
            Preview
          </h2>
          {channels.includes('push') && (
            <div className="banner neutral" style={{ margin: '0 0 8px' }}>
              <small className="muted">PUSH</small>
              <div>
                {title || '[Title]'}: {body || '[message]'}
              </div>
            </div>
          )}
          {channels.includes('sms') && (
            <div className="banner neutral" style={{ margin: '0 0 8px' }}>
              <small className="muted">SMS from ERP-GOV</small>
              <div>
                {body || '[Message]'}
                {kind === 'marketing' ? ' Reply STOP to opt out.' : ''}
              </div>
            </div>
          )}
          {channels.includes('whatsapp') && (
            <div className="banner success" style={{ margin: 0 }}>
              <small>WHATSAPP</small>
              <div>
                Template erp_notice: {title || '[Title]'}: {body || '[message]'}
              </div>
            </div>
          )}
        </section>
        <section className="card" aria-labelledby="cc">
          <h2 id="cc" style={{ marginTop: 0 }}>
            Cost and checks
          </h2>
          <div className="row">
            <span>Push</span>
            <strong>Free</strong>
          </div>
          <div className="row">
            <span>SMS, to people without the app</span>
            <strong>{naira(smsK)}</strong>
          </div>
          <div className="row">
            <span>WhatsApp, opted in</span>
            <strong>{naira(waK)}</strong>
          </div>
          <div className="row">
            <span>Total estimate</span>
            <strong style={{ color: 'var(--color-signal)' }}>{naira(smsK + waK)}</strong>
          </div>
          <div className="row">
            <span>Sender ID</span>
            <strong style={{ color: 'var(--color-success-text)' }}>Registered, ERP-GOV</strong>
          </div>
          <div className="banner warning" style={{ margin: '8px 0 0' }}>
            <strong style={{ display: 'block' }}>Check before sending</strong>
            Marketing messages go only to users who opted in. Safety notices can go to all in the area.
          </div>
        </section>
      </div>
      <section className="card" aria-labelledby="sr">
        <h2 id="sr" style={{ marginTop: 0 }}>
          Sending rules
        </h2>
        <div className="banner critical" style={{ margin: '0 0 12px' }}>
          <strong style={{ display: 'block' }}>Sent by mistake?</strong>
          Push and WhatsApp cannot be recalled. Large sends need a second approver.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <button className="btn" type="button" disabled={busy || !title || !body || over > 0} onClick={() => submit('request_approval')}>
            Request approval
          </button>
          <button className="btn" type="button" disabled={busy || !title || !body} onClick={() => submit('draft')}>
            Save draft
          </button>
        </div>
      </section>
    </>
  );
}

function Campaigns({ apiBase, detailBase }: { apiBase: string; detailBase: string }) {
  const [list, setList] = useState<Campaign[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<Campaign[]>(`${apiBase}/campaigns`)
      .then(setList)
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not load campaigns.'));
  }, [apiBase]);
  return (
    <section className="card" style={{ padding: 0, overflowX: 'auto' }}>
      {err && (
        <div className="banner critical" role="alert" style={{ margin: 16 }}>
          {err}
        </div>
      )}
      {!list && !err ? (
        <div style={{ padding: 20 }}>
          <div className="skeleton" />
        </div>
      ) : !list?.length ? (
        <div className="empty">No campaigns yet.</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Kind</th>
              <th>Channels</th>
              <th>People</th>
              <th>Reached</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link href={`${detailBase}/${c.id}`}>
                    <strong>{c.title}</strong>
                  </Link>
                  <div className="muted">
                    {c.by}, {new Date(c.sentAt ?? c.sendAt ?? Date.now()).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </div>
                </td>
                <td>{c.kind === 'safety' ? 'Safety' : 'Marketing'}</td>
                <td>{c.channels.map((x) => (x === 'sms' ? 'SMS' : x === 'whatsapp' ? 'WhatsApp' : 'Push')).join(', ')}</td>
                <td>{c.people || '—'}</td>
                <td>{c.reachedPct != null ? `${c.reachedPct}%` : '—'}</td>
                <td>
                  <strong style={{ color: STATE[c.state]?.[1] }}>{STATE[c.state]?.[0] ?? c.state}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Consent() {
  const [c, setC] = useState<{ users: number; optedOut: number; whatsappOptIn: number; noPhone: number } | null>(null);
  useEffect(() => {
    api<typeof c>('/admin/crm/consent')
      .then(setC)
      .catch(() => setC(null));
  }, []);
  return (
    <>
      <div className="stats">
        <div className="stat">
          <span>Active users</span>
          <strong>{c?.users ?? '—'}</strong>
          <small>Can get safety notices</small>
        </div>
        <div className="stat">
          <span>Opted out of marketing</span>
          <strong className="warning">{c?.optedOut ?? '—'}</strong>
          <small>Never get marketing</small>
        </div>
        <div className="stat">
          <span>WhatsApp opted in</span>
          <strong className="success">{c?.whatsappOptIn ?? '—'}</strong>
          <small>Can get WhatsApp</small>
        </div>
        <div className="stat">
          <span>No phone number</span>
          <strong className="critical">{c?.noPhone ?? '—'}</strong>
          <small>Push and inbox only</small>
        </div>
      </div>
      <section className="card">
        <p style={{ margin: 0 }}>
          People choose marketing messages in their app under Notifications. Replying STOP to an SMS opts them out. Safety, account and money messages cannot be switched off. Opt-outs are honoured on the next send.
        </p>
      </section>
    </>
  );
}
