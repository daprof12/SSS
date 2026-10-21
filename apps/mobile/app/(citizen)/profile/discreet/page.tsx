'use client';

import { useEffect, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api } from '@/lib/client';

/** Discreet mode (Design Brief, Emergency UX rules): for when someone nearby may read your phone. */
export default function Discreet() {
  const [on, setOn] = useState<boolean | null>(null);
  const [toast, setToast] = useToast();
  useEffect(() => {
    api<{ preferences: { discreetMode: boolean } }>('/me')
      .then((m) => setOn(m.preferences.discreetMode))
      .catch(() => setOn(false));
  }, []);
  const flip = async () => {
    const next = !on;
    setOn(next);
    try {
      await api('/me/preferences', { method: 'PATCH', body: JSON.stringify({ discreetMode: next }) });
      setToast(next ? 'Discreet mode is on.' : 'Discreet mode is off.');
    } catch {
      setOn(!next);
      setToast('Could not save. Try again.');
    }
  };
  return (
    <main className="app">
      <Header title="Discreet mode" back="/profile" />
      <p className="muted" style={{ marginTop: -8 }}>
        For when someone near you may see your phone, for example in domestic violence. Help still comes the same way and just as fast.
      </p>
      <div className="list">
        <div className="row" style={{ cursor: 'default' }}>
          <span className="grow">
            <strong>Discreet mode</strong>
            <span className="sub">{on ? 'On for every new report' : 'Off'}</span>
          </span>
          <button className="toggle" type="button" role="switch" aria-checked={!!on} aria-label="Discreet mode" disabled={on === null} onClick={flip} />
        </div>
      </div>
      <p className="section-label">When it is on</p>
      <div className="list">
        {[
          ['bell', 'Plain notifications', 'They say "Update: your request is in progress", never the type of report or a name.'],
          ['contacts', 'Contacts are not told', 'Your emergency contacts get no text for a discreet report.'],
          ['eye', 'Every report starts discreet', 'The report screen opens with discreet already on.'],
        ].map(([icon, title, line]) => (
          <div key={title} className="row" style={{ cursor: 'default', alignItems: 'flex-start', paddingTop: 14, paddingBottom: 14 }}>
            <span className="icon">
              <Icon name={icon!} />
            </span>
            <span className="grow">
              <strong>{title}</strong>
              <span className="sub">{line}</span>
            </span>
          </div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
        You can also turn it on for a single report from the report screen.
      </p>
      <Toast msg={toast} />
    </main>
  );
}
