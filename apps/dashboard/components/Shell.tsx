'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AgencyProvider, useAgency } from './Agency';
import { NotificationBell } from './NotificationBell';
import { ThemeSwitch } from '@erp/web-ui/ThemeSwitch';
import { api, getSession, setSession, type Session } from '@erp/web-ui/api';
import { applyMotion, applyTheme, onThemeChange, readTheme, type ThemeChoice } from '@erp/web-ui/theme';
import { holds, type Permission } from '@erp/domain';
import { HelpChat, openHelpChat } from '@erp/web-ui/HelpChat';
import { NotificationSounds } from '@erp/web-ui/NotificationSounds';
import { AgencyLogo, BRAND_CHANGED_EVENT } from '@erp/web-ui/AgencyLogo';

/** The agency (and station) the signed-in person works for, from /me. */
interface Brand {
  agencyId: string;
  agencyName: string;
  stationName: string | null;
  logoUrl: string | null;
}

interface NavItem {
  label: string;
  href: string;
  built?: boolean;
  /** Other path prefixes that belong to this item (e.g. a tip opened from a notification). */
  also?: string[];
}

const AGENCY_BUILT: Record<string, NavItem> = {
  Overview: { label: 'Overview', href: '/agency/overview', built: true },
  Stations: { label: 'Stations', href: '/agency/stations', built: true },
  'Live map': { label: 'Live map', href: '/agency/live', built: true },
  'Learn feed': { label: 'Learn feed', href: '/agency/learn', built: true },
  Bounties: { label: 'Bounties', href: '/agency/bounties', built: true, also: ['/agency/tips'] },
  'Public issues': { label: 'Public issues', href: '/agency/issues', built: true },
  'Stolen items': { label: 'Stolen items', href: '/agency/stolen', built: true },
  Payouts: { label: 'Payouts and donations', href: '/agency/payouts', built: true },
  Statements: { label: 'Statements', href: '/agency/statements', built: true },
  Officers: { label: 'Officers', href: '/agency/officers', built: true },
  Inventory: { label: 'Inventory', href: '/agency/inventory', built: true },
  'Control centre': { label: 'Control centre', href: '/agency/control', built: true },
  'Routing rules': { label: 'Routing rules', href: '/agency/routing', built: true },
  Billing: { label: 'Billing', href: '/agency/billing', built: true },
  Assets: { label: 'Assets', href: '/agency/assets', built: true },
  Messaging: { label: 'Messaging', href: '/agency/messaging', built: true },
  Settings: { label: 'Settings', href: '/agency/settings', built: true },
};

const ADMIN_BUILT: Record<string, NavItem> = {
  Overview: { label: 'Overview', href: '/admin/overview', built: true },
  'Live incident map': { label: 'Live incident map', href: '/admin/live', built: true },
  Users: { label: 'Users', href: '/admin/users', built: true },
  Subscriptions: { label: 'Subscriptions', href: '/admin/subscriptions', built: true },
  'KYC queue': { label: 'KYC queue', href: '/admin/kyc', built: true },
  Donations: { label: 'Donations and payouts', href: '/admin/payouts', built: true },
  Settings: { label: 'Settings', href: '/admin/settings', built: true },
  'Learn feed': { label: 'Learn feed', href: '/admin/learn', built: true },
  'Fines and appeals': { label: 'Fines and appeals', href: '/admin/fines', built: true },
  'Installation team': { label: 'Installation team', href: '/admin/repairs', built: true },
  'Help inbox': { label: 'Help inbox', href: '/admin/support', built: true },
  'Coverage map': { label: 'Coverage map', href: '/admin/coverage', built: true },
  'Device wall': { label: 'Device wall', href: '/admin/devices', built: true },
  'Fleet and access': { label: 'Fleet and access', href: '/admin/fleet', built: true },
  Inventory: { label: 'Inventory', href: '/admin/inventory', built: true },
  Agencies: { label: 'Agencies', href: '/admin/agencies', built: true },
  'Item types': { label: 'Stolen-item types', href: '/admin/item-types', built: true },
  'Audit log': { label: 'Audit log', href: '/admin/audit', built: true },
  'AI and LLM': { label: 'AI and LLM', href: '/admin/ai', built: true },
  'CRM messaging': { label: 'CRM messaging', href: '/admin/crm', built: true },
};

// Sidebar orders from the Public Issues doc: Settings last, Messaging above it.
const NAV: Record<string, NavItem[]> = {
  station: [
    { label: 'Live incidents', href: '/incidents', built: true, also: ['/statements'] },
    { label: 'Map', href: '/station/map', built: true },
    { label: 'Control centre', href: '/station/control', built: true },
    { label: 'Officers', href: '/station/officers', built: true },
    { label: 'Reports', href: '/station/reports', built: true },
    { label: 'Statements', href: '/station/statements', built: true },
    { label: 'Roster', href: '/station/roster', built: true },
    { label: 'Messages', href: '/station/messages', built: true },
    { label: 'Payout', href: '/station/payouts', built: true },
    { label: 'Settings', href: '/station/settings', built: true },
  ],
  agency: [
    'Overview', 'Live map', 'Control centre', 'Stations', 'Officers', 'Statements', 'Inventory', 'Routing rules', 'Bounties', 'Billing', 'Payouts', 'Public issues', 'Stolen items', 'Learn feed', 'Assets', 'Messaging', 'Settings',
  ].map((l) => AGENCY_BUILT[l] ?? { label: l, href: `/soon?page=${encodeURIComponent(l)}` }),
  admin: [
    'Overview', 'Live incident map', 'Coverage map', 'Device wall', 'Fleet and access', 'Users', 'Inventory', 'Installation team', 'Subscriptions', 'KYC queue', 'Fines and appeals', 'Help inbox', 'Donations', 'Learn feed', 'Agencies', 'Item types', 'Audit log', 'AI and LLM', 'CRM messaging', 'Settings',
  ].map((l) => ADMIN_BUILT[l] ?? { label: l, href: `/soon?page=${encodeURIComponent(l)}` }),
};

/** Which permission opens each sidebar item (the API enforces the same matrix). */
const PERM: Record<string, Permission> = {
  // Platform
  '/admin/overview': 'platform.overview',
  '/admin/live': 'platform.live',
  '/admin/coverage': 'platform.devices',
  '/admin/devices': 'platform.devices',
  '/admin/fleet': 'platform.devices',
  '/admin/users': 'platform.users',
  '/admin/inventory': 'platform.devices',
  '/admin/repairs': 'platform.devices',
  '/admin/subscriptions': 'platform.money',
  '/admin/kyc': 'platform.kyc',
  '/admin/fines': 'platform.fines',
  '/admin/support': 'platform.support',
  '/admin/payouts': 'platform.money',
  '/admin/learn': 'platform.learn',
  '/admin/agencies': 'platform.agencies',
  '/admin/audit': 'platform.audit',
  '/admin/ai': 'platform.ai',
  '/admin/crm': 'platform.crm',
  '/admin/settings': 'platform.settings',
  '/admin/item-types': 'platform.settings',
  // Agency
  '/agency/overview': 'agency.view',
  '/agency/billing': 'agency.money',
  '/agency/payouts': 'agency.money',
  '/agency/bounties': 'agency.money',
  '/agency/settings': 'agency.view',
  '/agency': 'agency.operations',
  // Station
  '/station/payouts': 'station.manage',
  '/station': 'station.operations',
  '/incidents': 'station.operations',
};
const permFor = (href: string) => PERM[Object.keys(PERM).filter((k) => href.startsWith(k)).sort((a, b) => b.length - a.length)[0] ?? ''];
type Grant = { role: string; scopeId: string | null };
const STAFF_QUESTIONS = ['How does routing by area work?', 'How do I take a statement in person?', 'How do I add an officer?', 'Who can see device clips?'];

export function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [session, setS] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [roles, setRoles] = useState<Grant[] | null>(null);
  const [brand, setBrand] = useState<Brand | null>(null);

  useEffect(() => {
    const s = getSession();
    if (!s) router.replace('/sign-in');
    else setS(s);
    setReady(true);
    if (!s) return;
    // The account's saved appearance wins over this browser's last choice (Public Issues doc §6).
    const load = () =>
      api<{ preferences: { theme: ThemeChoice; reduceMotion: boolean }; roles: Grant[]; brand: Brand | null }>('/me')
        .then((m) => {
          applyTheme(m.preferences.theme);
          applyMotion(m.preferences.reduceMotion);
          setRoles(m.roles);
          setBrand(m.brand);
        })
        .catch(() => {});
    void load();
    // A new logo from Agency settings shows here straight away.
    window.addEventListener(BRAND_CHANGED_EVENT, load);
    return () => window.removeEventListener(BRAND_CHANGED_EVENT, load);
  }, [router]);

  if (!ready || !session) return null;
  // The surface follows the person's roles once known (a platform role wins, then agency, then station).
  const surface = roles
    ? roles.some((r) => r.role.startsWith('platform_'))
      ? 'admin'
      : roles.some((r) => r.role.startsWith('agency_'))
        ? 'agency'
        : 'station'
    : session.roleLabel.startsWith('Platform')
      ? 'admin'
      : session.roleLabel.startsWith('Agency')
        ? 'agency'
        : 'station';
  const allowed = (href: string) => {
    const perm = permFor(href);
    return !roles || !perm || holds(roles, perm);
  };
  const items = NAV[surface]!.filter((i) => !i.built || allowed(i.href));
  const blocked = roles && !allowed(path) && !path.startsWith('/profile') && !path.startsWith('/statements');
  const current = (i: NavItem) => i.built && [i.href, ...(i.also ?? [])].some((p) => path.startsWith(p));

  const shell = (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <nav className="rail" aria-label="Main">
        <div className="brand">
          {surface !== 'admin' && brand ? (
            <AgencyLogo url={brand.logoUrl} name={brand.agencyName} size={40} />
          ) : (
            <div className="brand-mark" aria-hidden>
              ERP
            </div>
          )}
          <div>
            <strong>{surface === 'station' ? (brand?.stationName ?? 'Your station') : surface === 'agency' ? <AgencyName /> : 'Platform admin'}</strong>
            <small>{surface === 'station' && brand ? brand.agencyName : session.roleLabel}</small>
          </div>
        </div>
        <div className="rail-links">
          <RailLinks items={items} current={current} gated={surface === 'agency'} />
        </div>
        <div className="rail-foot">
          <div className="who">
            <strong>{session.name}</strong>
            <small>{session.roleLabel}</small>
          </div>
          <SignOutButton />
        </div>
      </nav>
      <div className="main">
        <TopBar session={session} />
        <main id="main" className="content">
          {blocked ? (
            <div className="card empty" role="alert">
              <strong>Your role does not include this page.</strong>
              Ask your admin if you need it. <Link href={items[0]?.href ?? '/'}>Go to {items[0]?.label ?? 'home'}</Link>
            </div>
          ) : (
            children
          )}
        </main>
      </div>
      <HelpChat suggestions={STAFF_QUESTIONS} fab={false} />
      <NotificationSounds everyMs={5000} />
    </div>
  );
  return surface === 'agency' ? <AgencyProvider>{shell}</AgencyProvider> : shell;
}

/** Agency menus that depend on what the agency handles: hidden until known, so they never flash in and out. */
const GATED: Record<string, 'tips' | 'issues' | 'stolen'> = { Bounties: 'tips', 'Public issues': 'issues', 'Stolen items': 'stolen' };

function RailLinks({ items, current, gated }: { items: NavItem[]; current: (i: NavItem) => boolean | undefined; gated: boolean }) {
  const { agency } = useAgency();
  const shown = gated ? items.filter((i) => !GATED[i.label] || !!agency?.handles[GATED[i.label]!]) : items;
  return (
    <>
      {shown.map((i) => (
        <Link key={i.label} href={i.href} aria-current={current(i) ? 'page' : undefined}>
          {i.label}
          {!i.built && <span className="soon">next</span>}
        </Link>
      ))}
    </>
  );
}

/** Ends the session on the server too, so the token cannot be reused, then goes to sign-in. */
async function signOut(router: ReturnType<typeof useRouter>) {
  await api('/auth/sign-out', { method: 'POST', body: '{}' }).catch(() => {});
  setSession(null);
  router.replace('/sign-in');
}

function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="rail-signout"
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void signOut(router);
      }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <path d="M16 17l5-5-5-5" />
        <path d="M21 12H9" />
      </svg>
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}

function AgencyName() {
  const { agency } = useAgency();
  return <>{agency?.name ?? 'Agency'}</>;
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
      <button className="icon-btn" type="button" aria-label="Help chat" title="Help chat" onClick={openHelpChat}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>
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
          <button role="menuitem" type="button" onClick={() => signOut(router)}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
