// Stylised map until a maps provider is chosen (TRD "maps and routing").
// Places the building and the unit by their real offsets; the unit glides
// between updates instead of jumping (motion spec: marker interpolates).
interface P {
  lat: number;
  lng: number;
}

export function MiniMap({ building, unit, label }: { building?: P; unit?: P; label?: string }) {
  const W = 390;
  const H = 260;
  let bx = W * 0.7;
  let by = H * 0.32;
  let ux = W * 0.2;
  let uy = H * 0.78;
  if (building && unit) {
    // Fit both points with margin; y grows downward as latitude falls.
    const dLng = unit.lng - building.lng;
    const dLat = unit.lat - building.lat;
    const span = Math.max(Math.abs(dLng), Math.abs(dLat), 0.002);
    const k = Math.min(W, H) * 0.38 / span;
    bx = W / 2 - (dLng * k) / 2;
    by = H / 2 + (dLat * k) / 2;
    ux = W / 2 + (dLng * k) / 2;
    uy = H / 2 - (dLat * k) / 2;
  }
  return (
    <div className="map" aria-label={label ?? 'Map'} role="img">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
        <rect width={W} height={H} fill="var(--color-surface)" />
        {[40, 110, 180, 250, 320].map((x) => (
          <rect key={`v${x}`} x={x} y={0} width={14} height={H} fill="var(--color-surface-raised)" />
        ))}
        {[50, 130, 205].map((y) => (
          <rect key={`h${y}`} x={0} y={y} width={W} height={14} fill="var(--color-surface-raised)" />
        ))}
        {unit && <line x1={ux} y1={uy} x2={bx} y2={by} stroke="var(--color-signal)" strokeWidth={4} strokeDasharray="2 10" strokeLinecap="round" />}
        <circle cx={bx} cy={by} r={30} fill="var(--color-emergency)" opacity={0.18} />
        <circle cx={bx} cy={by} r={13} fill="var(--color-emergency)" stroke="var(--color-bg)" strokeWidth={4} />
        {unit && (
          <g className="unit" style={{ transform: `translate(${ux}px, ${uy}px)` }}>
            <circle r={13} fill="var(--color-signal)" stroke="var(--color-bg)" strokeWidth={4} />
          </g>
        )}
      </svg>
    </div>
  );
}
