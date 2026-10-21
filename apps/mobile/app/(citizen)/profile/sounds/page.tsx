'use client';
// Notification sounds: a sound for safety alerts, report updates and everything else.
import { SoundSettings } from '@erp/web-ui/SoundSettings';
import { Header } from '@/components/AppFrame';

export default function Sounds() {
  return (
    <main className="app">
      <Header title="Notification sounds" back="/profile" />
      <p className="muted" style={{ marginTop: -8 }}>
        Choose what you hear for each kind of notification. Tap Play to hear it.
      </p>
      <div className="card">
        <SoundSettings kinds={['safety', 'reports', 'general']} />
      </div>
    </main>
  );
}
