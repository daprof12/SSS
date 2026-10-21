'use client';
// Officer notification sounds: offers and incoming reports first, then everything else.
import { SoundSettings } from '@erp/web-ui/SoundSettings';
import { Header } from '@/components/AppFrame';

export default function OfficerSounds() {
  return (
    <main className="app bare">
      <Header title="Notification sounds" back="/officer/profile" />
      <p className="muted" style={{ marginTop: -8 }}>
        A loud sound for new offers helps you accept in time. Tap Play to hear each one.
      </p>
      <div className="card">
        <SoundSettings />
      </div>
    </main>
  );
}
