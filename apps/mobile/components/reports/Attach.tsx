'use client';
// Photos, short videos and voice notes on issues, tips and live reports.
// Picked files stay on the phone until the report exists, then upload with progress.
import { API_URL, api, ApiError, ensureFreshToken, getSession } from '@erp/web-ui/api';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { haptic } from '@/lib/client';

export type OwnerType = 'tip' | 'issue_case' | 'incident' | 'field_report' | 'fine' | 'repair' | 'statement';
export interface Picked {
  key: string;
  file: File;
  url: string;
  kind: 'photo' | 'video' | 'voice';
  /** Voice notes and videos: length in seconds. */
  durationS?: number;
  state: 'local' | 'uploading' | 'done' | 'error';
  progress: number;
  error?: string;
}

const MAX_BYTES = 10 * 1024 * 1024;
const PHOTO = ['image/jpeg', 'image/png', 'image/webp'];
const VIDEO = ['video/mp4', 'video/quicktime'];
const VOICE = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg'];
const MAX_VOICE_S = 120;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const MAX_FILES = 6;
const REJECT = 'This file is too large or not supported.';

/** Local list of picked files. Object URLs are freed when an item is removed or the screen closes. */
export function usePicked() {
  const [items, setItems] = useState<Picked[]>([]);
  const ref = useRef(items);
  ref.current = items;
  useEffect(() => () => ref.current.forEach((p) => URL.revokeObjectURL(p.url)), []);
  return {
    items,
    /** A recorded voice note. */
    addVoice(file: File, durationS: number): string | null {
      if (ref.current.length >= MAX_FILES) return `You can add up to ${MAX_FILES} files.`;
      if (file.size > MAX_BYTES) return REJECT;
      setItems((xs) => [...xs, { key: `${Date.now()}-${Math.random()}`, file, url: URL.createObjectURL(file), kind: 'voice', durationS, state: 'local', progress: 0 }]);
      return null;
    },
    add(files: FileList | null): string | null {
      if (!files) return null;
      let error: string | null = null;
      const next: Picked[] = [];
      for (const file of Array.from(files)) {
        const kind = PHOTO.includes(file.type) ? 'photo' : VIDEO.includes(file.type) ? 'video' : null;
        if (!kind || file.size > MAX_BYTES) {
          error = REJECT;
          continue;
        }
        if (ref.current.length + next.length >= MAX_FILES) {
          error = `You can add up to ${MAX_FILES} files.`;
          break;
        }
        next.push({ key: `${Date.now()}-${Math.random()}`, file, url: URL.createObjectURL(file), kind, state: 'local', progress: 0 });
      }
      if (next.length) haptic(10);
      setItems((xs) => [...xs, ...next]);
      return error;
    },
    remove(key: string) {
      setItems((xs) => {
        const gone = xs.find((x) => x.key === key);
        if (gone) URL.revokeObjectURL(gone.url);
        return xs.filter((x) => x.key !== key);
      });
    },
    patch(key: string, p: Partial<Picked>) {
      setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));
    },
    clear() {
      ref.current.forEach((p) => URL.revokeObjectURL(p.url));
      setItems([]);
    },
  };
}

function put(url: string, file: File, onProgress: (n: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', `${API_URL}${url}`);
    x.setRequestHeader('Content-Type', file.type);
    x.setRequestHeader('Authorization', `Bearer ${getSession()?.token ?? ''}`);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) return resolve();
      let message = REJECT;
      try {
        message = JSON.parse(x.responseText).message ?? message;
      } catch {}
      reject(new ApiError(x.status, 'upload_failed', message));
    };
    x.onerror = () => reject(new ApiError(0, 'offline', 'You are offline. Try again when you have signal.'));
    x.send(file);
  });
}

/** Uploads every file not yet sent. Returns how many failed (each keeps its own error). */
export async function uploadPicked(ownerType: OwnerType, ownerId: string, picked: ReturnType<typeof usePicked>): Promise<number> {
  await ensureFreshToken();
  let failed = 0;
  for (const p of picked.items) {
    if (p.state === 'done') continue;
    picked.patch(p.key, { state: 'uploading', progress: 0, error: undefined });
    try {
      const reg = await api<{ uploadUrl: string }>('/media', {
        method: 'POST',
        body: JSON.stringify({ ownerType, ownerId, contentType: p.file.type, sizeBytes: p.file.size, ...(p.durationS != null ? { durationS: Math.round(p.durationS) } : {}) }),
      });
      await put(reg.uploadUrl, p.file, (n) => picked.patch(p.key, { progress: n }));
      picked.patch(p.key, { state: 'done', progress: 1 });
    } catch (e) {
      failed++;
      picked.patch(p.key, { state: 'error', error: e instanceof ApiError ? e.message : REJECT });
    }
  }
  return failed;
}

/** Two dashed buttons and a strip of thumbnails. The phone's own camera opens on mobile. */
export function AttachPicker({ picked, error, disabled }: { picked: ReturnType<typeof usePicked>; error?: string | null; disabled?: boolean }) {
  const photo = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const shown = err ?? error ?? null;
  const pick = (files: FileList | null, input: HTMLInputElement | null) => {
    setErr(picked.add(files));
    if (input) input.value = '';
  };
  const [recording, setRecording] = useState(false);
  return (
    <div className="attach" data-invalid={!!shown}>
      {recording ? (
        <VoiceRecorder
          onCancel={() => setRecording(false)}
          onDone={(file, secs) => {
            setRecording(false);
            setErr(picked.addVoice(file, secs));
          }}
          onError={(m) => {
            setRecording(false);
            setErr(m);
          }}
        />
      ) : (
        <div className="btn-row attach-row">
          <button className="btn attach-add" type="button" disabled={disabled} onClick={() => photo.current?.click()}>
            <Icon name="photo" /> Photo
          </button>
          <button className="btn attach-add" type="button" disabled={disabled} onClick={() => video.current?.click()}>
            <Icon name="camera" /> Video
          </button>
          <button className="btn attach-add" type="button" disabled={disabled} onClick={() => (setErr(null), setRecording(true))}>
            <Icon name="mic" /> Voice note
          </button>
        </div>
      )}
      <input ref={photo} type="file" accept={PHOTO.join(',')} multiple hidden onChange={(e) => pick(e.target.files, e.target)} />
      <input ref={video} type="file" accept={VIDEO.join(',')} capture="environment" hidden onChange={(e) => pick(e.target.files, e.target)} />
      {picked.items.length > 0 && (
        <ul className="thumbs" aria-label="Files to send">
          {picked.items.map((p) => (
            <li key={p.key} className="thumb" data-state={p.state}>
              {p.kind === 'photo' ? <img src={p.url} alt="" /> : p.kind === 'voice' ? <VoiceTile url={p.url} seconds={p.durationS ?? 0} /> : <video src={p.url} muted playsInline preload="metadata" />}
              {p.kind === 'video' && <span className="thumb-badge">Video</span>}
              {p.state === 'uploading' && (
                <span className="thumb-progress" role="progressbar" aria-valuenow={Math.round(p.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <span style={{ transform: `scaleX(${p.progress})` }} />
                </span>
              )}
              {p.state === 'done' && (
                <span className="thumb-done" aria-label="Sent">
                  <Icon name="check" size={16} />
                </span>
              )}
              {(p.state === 'local' || p.state === 'error') && (
                <button type="button" className="thumb-remove" aria-label={`Remove ${p.kind}`} onClick={() => picked.remove(p.key)}>
                  <Icon name="close" size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {picked.items.some((p) => p.state === 'error') && <span className="field-error">{picked.items.find((p) => p.state === 'error')?.error}</span>}
      {shown && <span className="field-error">{shown}</span>}
      <p className="muted" style={{ margin: '6px 0 0', fontSize: 'var(--text-sm)' }}>
        Up to {MAX_FILES} files, 10 MB each, voice notes up to 2 minutes. Location data is removed from photos.
      </p>
    </div>
  );
}

interface Item {
  id: string;
  kind: 'photo' | 'video' | 'voice';
  url: string;
  durationS: number | null;
  mine: boolean;
}

/** Files already on a report. Fetched with the session token, so links never work for anyone else. */
export function Attachments({ ownerType, ownerId, refreshKey = 0, title = 'Photos and videos' }: { ownerType: OwnerType; ownerId: string; refreshKey?: number; title?: string }) {
  const [items, setItems] = useState<(Item & { blob?: string })[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const made: string[] = [];
    (async () => {
      const list = await api<Item[]>(`/attachments?ownerType=${ownerType}&ownerId=${ownerId}`).catch(() => []);
      if (!alive) return;
      setItems(list);
      await ensureFreshToken();
      for (const it of list) {
        const r = await fetch(`${API_URL}${it.url}`, { headers: { Authorization: `Bearer ${getSession()?.token ?? ''}` } }).catch(() => null);
        if (!r?.ok || !alive) continue;
        const blob = URL.createObjectURL(await r.blob());
        made.push(blob);
        setItems((xs) => xs?.map((x) => (x.id === it.id ? { ...x, blob } : x)) ?? null);
      }
    })();
    return () => {
      alive = false;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [ownerType, ownerId, refreshKey]);

  if (!items?.length) return null;
  const big = items.find((x) => x.id === open && x.kind !== 'voice');
  return (
    <>
      <p className="section-label">{title}</p>
      <ul className="thumbs" style={{ marginBottom: 12 }}>
        {items.map((it) => (
          <li key={it.id} className="thumb">
            {!it.blob ? (
              <span className="skeleton" style={{ height: '100%', margin: 0 }} />
            ) : it.kind === 'voice' ? (
              <VoiceTile url={it.blob} seconds={it.durationS ?? 0} />
            ) : (
              <button type="button" className="thumb-open" aria-label={`Open ${it.kind}`} onClick={() => setOpen(it.id)}>
                {it.kind === 'photo' ? <img src={it.blob} alt="" /> : <video src={it.blob} muted playsInline preload="metadata" />}
              </button>
            )}
            {it.kind === 'video' && <span className="thumb-badge">Video</span>}
          </li>
        ))}
      </ul>
      {big?.blob && (
        <div className="viewer" role="dialog" aria-modal="true" aria-label={big.kind === 'photo' ? 'Photo' : 'Video'} onClick={() => setOpen(null)} onKeyDown={(e) => e.key === 'Escape' && setOpen(null)}>
          {big.kind === 'photo' ? <img src={big.blob} alt="" /> : <video src={big.blob} controls autoPlay playsInline onClick={(e) => e.stopPropagation()} />}
          <button type="button" className="viewer-close" aria-label="Close" autoFocus onClick={() => setOpen(null)}>
            <Icon name="close" />
          </button>
        </div>
      )}
    </>
  );
}

/** Picker plus a send button, for adding files to a report that already exists. */
export function AddFiles({ ownerType, ownerId, onDone, cta = 'Send' }: { ownerType: OwnerType; ownerId: string; onDone: (sent: number) => void; cta?: string }) {
  const picked = usePicked();
  const [busy, setBusy] = useState(false);
  const waiting = picked.items.filter((p) => p.state !== 'done').length;
  return (
    <>
      <AttachPicker picked={picked} disabled={busy} />
      {waiting > 0 && (
        <button
          className="btn block signal"
          type="button"
          disabled={busy}
          style={{ marginBottom: 12 }}
          onClick={async () => {
            setBusy(true);
            const failed = await uploadPicked(ownerType, ownerId, picked);
            setBusy(false);
            if (!failed) {
              const sent = picked.items.length;
              picked.clear();
              onDone(sent);
            }
          }}
        >
          {busy ? 'Sending…' : `${cta} ${waiting} ${waiting === 1 ? 'file' : 'files'}`}
        </button>
      )}
    </>
  );
}

/** A voice note in the thumbnail strip: tap to hear it before sending. */
function VoiceTile({ url, seconds }: { url: string; seconds: number }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  return (
    <button
      type="button"
      className="voice-tile"
      aria-label={playing ? 'Pause voice note' : `Play voice note, ${clock(seconds)}`}
      onClick={() => {
        const a = audio.current;
        if (!a) return;
        if (a.paused) void a.play();
        else a.pause();
      }}
    >
      <Icon name={playing ? 'pause' : 'play'} size={22} />
      <span>{clock(seconds)}</span>
      <audio ref={audio} src={url} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
    </button>
  );
}

/** Pick a format this browser records: WebM/Opus (Chrome, Android) or MP4/AAC (Safari, iOS). */
function recorderType(): { mime: string; base: string; ext: string } | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const [mime, base, ext] of [
    ['audio/webm;codecs=opus', 'audio/webm', 'webm'],
    ['audio/webm', 'audio/webm', 'webm'],
    ['audio/mp4', 'audio/mp4', 'm4a'],
    ['audio/ogg;codecs=opus', 'audio/ogg', 'ogg'],
  ] as const) {
    if (MediaRecorder.isTypeSupported(mime)) return { mime, base, ext };
  }
  return null;
}

/**
 * Records a voice note with the microphone. Shows the time and a live level so people know
 * it is listening; stops by itself at 2 minutes. Nothing leaves the phone until the report is sent.
 */
export function VoiceRecorder({ onDone, onCancel, onError }: { onDone: (file: File, seconds: number) => void; onCancel: () => void; onError: (message: string) => void }) {
  const [secs, setSecs] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(24).fill(0.08));
  const [ready, setReady] = useState(false);
  const stopRef = useRef<(keep: boolean) => void>(() => {});

  useEffect(() => {
    const type = recorderType();
    if (!type || !navigator.mediaDevices?.getUserMedia) {
      onError('This phone cannot record here. Write it down instead.');
      return;
    }
    let stream: MediaStream | null = null;
    let rec: MediaRecorder | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let tick: ReturnType<typeof setInterval> | null = null;
    let keep = false;
    let cancelled = false;
    const chunks: Blob[] = [];
    const started = Date.now();
    const reduced = document.documentElement.dataset.motion === 'reduced';

    const cleanup = () => {
      cancelAnimationFrame(raf);
      if (tick) clearInterval(tick);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => {});
    };

    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        rec = new MediaRecorder(s, { mimeType: type.mime, audioBitsPerSecond: 32000 });
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        rec.onstop = () => {
          cleanup();
          if (!keep) return;
          const seconds = Math.min(MAX_VOICE_S, Math.round((Date.now() - started) / 1000));
          if (seconds < 1) return onError('That was too short. Hold on a little longer.');
          const file = new File(chunks, `voice-note-${Date.now()}.${type.ext}`, { type: type.base });
          onDone(file, seconds);
        };
        rec.start(1000);
        haptic(15);
        setReady(true);
        tick = setInterval(() => {
          const t = (Date.now() - started) / 1000;
          setSecs(t);
          if (t >= MAX_VOICE_S) stopRef.current(true);
        }, 250);
        if (!reduced) {
          ctx = new AudioContext();
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          ctx.createMediaStreamSource(s).connect(analyser);
          const data = new Uint8Array(analyser.frequencyBinCount);
          let last = 0;
          const draw = (now: number) => {
            raf = requestAnimationFrame(draw);
            if (now - last < 80) return;
            last = now;
            analyser.getByteTimeDomainData(data);
            let peak = 0;
            for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
            setLevels((xs) => [...xs.slice(1), Math.max(0.08, Math.min(1, peak * 2.2))]);
          };
          raf = requestAnimationFrame(draw);
        }
      })
      .catch(() => {
        cleanup();
        onError('Allow the microphone to record a voice note.');
      });

    stopRef.current = (k: boolean) => {
      keep = k;
      if (rec && rec.state !== 'inactive') rec.stop();
      else cleanup();
      if (!k) onCancel();
      else haptic(10);
    };
    return () => {
      cancelled = true;
      keep = false;
      if (rec && rec.state !== 'inactive') rec.stop();
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const left = Math.max(0, MAX_VOICE_S - secs);
  return (
    <div className="recorder" role="group" aria-label="Recording a voice note">
      <span className={`rec-dot ${ready ? 'on' : ''}`} aria-hidden />
      <span className="rec-time" aria-live="off">
        {clock(secs)}
      </span>
      <span className="rec-levels" aria-hidden>
        {levels.map((l, i) => (
          <i key={i} style={{ transform: `scaleY(${l})` }} />
        ))}
      </span>
      <span className="sr-only" aria-live="polite">
        {ready ? (left <= 10 ? `${Math.ceil(left)} seconds left` : 'Recording') : 'Starting the microphone'}
      </span>
      <button type="button" className="icon-btn" aria-label="Cancel recording" onClick={() => stopRef.current(false)}>
        <Icon name="close" size={18} />
      </button>
      <button type="button" className="btn signal small" disabled={!ready} onClick={() => stopRef.current(true)}>
        <Icon name="stop" size={16} /> Done
      </button>
    </div>
  );
}
