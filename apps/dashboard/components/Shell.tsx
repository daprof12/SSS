'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { NotificationBell } from './NotificationBell';
import { ThemeSwitch } from './ThemeSwitch';
import { api, getSession, setSession, type Session } from '@/lib/api';
import { applyMotion, applyTheme, onThemeChange, readTheme, type ThemeChoice } from '@/lib/theme';

interface NavItem {
  label: string;
  href: string;
  built?: boolean;
}

// Sidebar orders from the Public Issues doc: Settings last, Messaging above it.
const NAV: Record<string, NavItem[]> = {
  station: [
    { label: 'Live incidents', href: '/incidents', built: true },
    { label: 'Map', href: '/soon?page=Map' },
    { label: 'Officers', href: '/soon?page=Officers' },
    { label: 'Reports', href: '/soon?page=Reports' },
    { label: 'Roster', href: '/soon?page=Roster' },
    { label: 'Messages', href: '/soon?page=Messages' },
    { label: 'Settings', href: '/soon?page=Station settings' },
  ],
  agency: [
    'Overview', 'Stations', 'Officers', 'Inventory', 'Routing rules', 'Bounties', 'Billing', 'Payouts', 'Public issues', 'Assets', 'Messaging', 'Settings',
  ].map((l) => ({ label: l, href: `/soon?page=${encodeURIComponent(l)}` })),
  admin: [
    'Overview', 'Live incident map', 'Coverage map', 'Device wall', 'Users', 'Inventory', 'Installation team', 'Subscriptions', 'KYC queue', 'Fines and appeals', 'Donations', 'Learn feed', 'Agencies', 'Audit log', 'AI and LLM', 'CRM messaging', 'Settings',
  ].map((l) => ({ label: l, href: `/soon?page=${encodeURIComponent(l)}` })),
};

export function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [session, setS] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const s = getSession();
    if (!s) router.replace('/sign-in');
    else setS(s);
    setReady(true);
    if (!s) return;
    // The account's saved appearance wins over this browser's last choice (Public Issues doc §6).
    api<{ preferences: { theme: ThemeChoice; reduceMotion: boolean } }>('/me')
      .then((m) => {
        applyTheme(m.preferences.theme);
        applyMotion(m.preferences.reduceMotion);
      })
      .catch(() => {});
  }, [router]);

  if (!ready || !session) return null;
  const surface = session.roleLabel.startsWith('Platform') ? 'admin' : session.roleLabel.startsWith('Agency') ? 'agency' : 'station';
  const items = NAV[surface]!;

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <nav className="rail" aria-label="Main">
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            ERP
          </div>
          <div>
            <strong>{surface === 'station' ? 'Station 4 Ikeja' : surface === 'agency' ? 'Police (demo)' : 'Platform admin'}</strong>
            <small>{session.roleLabel}</small>
          </div>
        </div>
        {items.map((i) => (
          <Link key={i.label} href={i.href} aria-current={i.built && path.startsWith(i.href) ? 'page' : undefined}>
            {i.label}
            {!i.built && <span className="soon">next</span>}
          </Link>
        ))}
      </nav>
      <div className="main">
        <TopBar session={session} />
        <main id="main" className="content">
          {children}
        </main>
      </div>
    </div>
  );
}

function TopBar({ session }: { session: Session }) {
  const [theme, setTheme] = useState<ThemeChoice>('system');
  useEffect(() => {
    setTheme(readTheme());
    return onThemeChange(setTheme);
  }, []);

  const choose = (t: ThemeChoice) => {
    const before = theme;
    applyTheme(t);
    api('/me/preferences', { method: 'PATCH', body: JSON.stringify({ theme: t }) }).catch(() => applyTheme(before));
  };

  return (
    <header className="topbar">
      <input className="search" type="search" placeholder="Search postcode, report or officer" aria-label="Search" />
      <div className="spacer" />
      <ThemeSwitch compact value={theme} onChange={choose} />
      <NotificationBell />
      <UserMenu session={session} />
    </header>
  );
}

function UserMenu({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const initials = session.name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2);

  return (
    <div className="menu" ref={ref}>
      <button className="avatar" type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {initials}
      </button>
      {open && (
        <div className="menu-panel" role="menu">
          <header>
            <strong>{session.name}</strong>
            <small>{session.roleLabel}</small>
          </header>
          <Link role="menuitem" href="/profile" onClick={() => setOpen(false)}>
            My profile
          </Link>
          <Link role="menuitem" href="/profile#security" onClick={() => setOpen(false)}>
            Security
          </Link>
          <Link role="menuitem" href="/profile#appearance" onClick={() => setOpen(false)}>
            Appearance
          </Link>
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setSession(null);
              router.replace('/sign-in');
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
