'use client';
// A QR code drawn as SVG squares (no HTML is injected). Used for the authenticator-app set-up link.
import qrcode from 'qrcode-generator';

export function Qr({ text, size = 200, label }: { text: string; size?: number; label: string }) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const cells: string[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) cells.push(`M${c + 4} ${r + 4}h1v1h-1z`);
  return (
    <svg viewBox={`0 0 ${n + 8} ${n + 8}`} width={size} height={size} role="img" aria-label={label} style={{ background: '#fff', borderRadius: 8 }}>
      <path d={cells.join('')} fill="#000" shapeRendering="crispEdges" />
    </svg>
  );
}
