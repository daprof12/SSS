'use client';
// An agency's logo, or its initials on a plain tile when it has none. Used on the dashboards of the
// agency and its stations, and in its officers' app.
import { useState } from 'react';
import { API_URL } from './api';

/** Tells open screens a logo changed, so headers reload it. */
export const BRAND_CHANGED_EVENT = 'erp-brand-changed';

export function AgencyLogo({ url, name, size = 40, radius = 10 }: { url: string | null | undefined; name: string; size?: number; radius?: number }) {
  const [broken, setBroken] = useState<string | null>(null);
  const initials =
    name
      .replace(/\(.*?\)/g, '')
      .split(/\s+/)
      .filter((w) => /^[A-Za-z]/.test(w) && !['of', 'the', 'and'].includes(w.toLowerCase()))
      .slice(0, 3)
      .map((w) => w[0]!.toUpperCase())
      .join('') || 'ERP';
  if (url && broken !== url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`${API_URL}${url}`}
        alt={`${name} logo`}
        width={size}
        height={size}
        onError={() => setBroken(url)}
        style={{ width: size, height: size, borderRadius: radius, objectFit: 'contain', background: '#fff', flex: 'none', border: '1px solid var(--color-divider, #333)' }}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        flex: 'none',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--color-action-primary, #e11d48)',
        color: 'var(--color-on-action-primary, #fff)',
        fontWeight: 800,
        fontSize: Math.round(size * 0.32),
      }}
    >
      {initials}
    </span>
  );
}
