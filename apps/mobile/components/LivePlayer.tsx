'use client';
// Live camera view (B6). The API decides who may watch and logs every start ("Who viewed my camera").
// A camera with a provider stream plays it; in development there is no provider, so a clearly
// labelled test feed stands in. A session ends after the time the API gives (5 minutes).
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/client';
import { Icon } from './Icon';

type Live = { mode: 'stream'; url: string; expiresInSeconds: number } | { mode: 'test'; note: string; expiresInSeconds: number };

export function LivePlayer({ deviceId, name, onError }: { deviceId: string; name: string; onError: (m: string) => void }) {
  const [live, setLive] = useState<Live | null>(null);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(0);

  const start = async () => {
    setBusy(true);
    try {
      const l = await api<Live>(`/me/devices/${deviceId}/live`);
      setLive(l);
      setLeft(l.expiresInSeconds);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Could not start live view. Try again.');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setLeft((s) => (s <= 1 ? (setLive(null), 0) : s - 1)), 1000);
    return () => clearInterval(t);
  }, [live]);

  if (!live) {
    return (
      <div className="camera-frame">
        <Icon name="camera" size={40} />
        <strong>Live view</strong>
        <span className="muted">Only you and household members you allow can see this. Each view is recorded for the owner.</span>
        <button className="btn small" type="button" onClick={start} disabled={busy} style={{ marginTop: 8 }}>
          {busy ? 'Connecting…' : 'Start live view'}
        </button>
      </div>
    );
  }
  return (
    <div className="camera-frame" style={{ padding: 0 }}>
      <span className="live-tag" style={{ zIndex: 2 }}>
        <i /> LIVE · {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
      </span>
      {live.mode === 'stream' ? (
        // Providers give HLS (plays natively on iPhone) or MP4; the URL is short-lived and signed.
        <video src={live.url} autoPlay muted playsInline controls style={{ width: '100%', height: '100%', objectFit: 'cover' }} aria-label={`Live view, ${name}`} />
      ) : (
        <TestFeed name={name} note={live.note} />
      )}
      <button className="btn small" type="button" onClick={() => setLive(null)} style={{ position: 'absolute', right: 10, top: 8, zIndex: 2 }}>
        Stop
      </button>
    </div>
  );
}

/** A moving test pattern with the time, so it is obvious this is not a real camera. */
function TestFeed({ name, note }: { name: string; note: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    let raf = 0;
    const reduced = document.documentElement.dataset.motion === 'reduced';
    const bars = ['#c9c9c9', '#c9c900', '#00c9c9', '#00c900', '#c900c9', '#c90000', '#0000c9'];
    const draw = (t: number) => {
      const w = (c.width = c.clientWidth * devicePixelRatio);
      const h = (c.height = c.clientHeight * devicePixelRatio);
      bars.forEach((col, i) => {
        ctx.fillStyle = col;
        ctx.fillRect((i * w) / bars.length, 0, w / bars.length + 1, h * 0.7);
      });
      ctx.fillStyle = '#111';
      ctx.fillRect(0, h * 0.7, w, h * 0.3);
      // A sweep line moves so the feed visibly updates.
      const x = reduced ? w / 2 : ((t / 20) % w);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillRect(x, 0, 3 * devicePixelRatio, h * 0.7);
      ctx.fillStyle = '#fff';
      ctx.font = `${14 * devicePixelRatio}px ui-monospace, monospace`;
      ctx.fillText(`TEST FEED · ${name}`, 12 * devicePixelRatio, h * 0.8);
      ctx.fillText(new Date().toLocaleTimeString('en-GB'), 12 * devicePixelRatio, h * 0.92);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [name]);
  return (
    <>
      <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} role="img" aria-label={`Test feed for ${name}`} />
      <span style={{ position: 'absolute', left: 10, right: 10, bottom: 8, fontSize: 12, color: '#fff', background: 'rgba(0,0,0,0.6)', padding: '4px 8px', borderRadius: 8 }}>{note}</span>
    </>
  );
}
