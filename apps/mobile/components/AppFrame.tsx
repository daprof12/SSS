'use client';

import { HelpChat } from '@erp/web-ui/HelpChat';
import { NotificationSounds } from '@erp/web-ui/NotificationSounds';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { SIGNED_OUT_EVENT } from '@erp/web-ui/api';
import { applyMotion, applyTheme, type ThemeChoice } from '@erp/web-ui/theme';
import { api, getSession, type Session } from '@/lib/client';
import { Icon } from './Icon';

type Surface = 'citizen' | 'officer';

/** Signs the person in to the right surface, applies their saved appearance, draws the tab bar. */
// Full-screen flows (reporting, live status, payment, offers) hide the tab bar.
const OFFICER_QUESTIONS = ['How do I take a statement in person?', 'How do I swap a shift?', 'How are rewards shared?', 'What if I miss an offer?'];
const NO_BAR = ['/welcome', '/statements/', '/profile/home/', '/fines/', '/donate', '/payments/', '/learn/interests', '/tips/', '/issues/', '/officer/tips/', '/officer/issues/', '/report', '/reports/', '/pay/', '/wallet/fund', '/wallet/confirm', '/wallet/withdraw', '/wallet/bank', '/officer/wallet/withdraw', '/officer/wallet/bank', '/officer/offers/', '/officer/incidents/', '/officer/statements/'];

export function AppFrame({ surface, children }: { surface: Surface; children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const bar = !NO_BAR.some((p) => path.startsWith(p));
  const [session, setS] = useState<Session | null>(null);

  // A session that can no longer be refreshed sends the person to sign in.
  useEffect(() => {
    const out = () => router.replace('/sign-in');
    window.addEventListener(SIGNED_OUT_EVENT, out);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, out);
  }, [router]);

  useEffect(() => {
    const s = getSession();
    if (!s) return router.replace('/sign-in');
    if (s.surface !== surface) return router.replace(s.surface === 'officer' ? '/officer' : '/home');
    setS(s);
    api<{ preferences: { theme: ThemeChoice; reduceMotion: boolean } }>('/me')
      .then((m) => {
        applyTheme(m.preferences.theme);
        applyMotion(m.preferences.reduceMotion);
      })
      .catch(() => {});
  }, [router, surface]);

  if (!session) return null;
  return (
    <>
      {children}
      <NotificationSounds everyMs={surface === 'officer' ? 4000 : 8000} />
      {bar && (surface === 'citizen' ? <CitizenBar /> : <OfficerBar />)}
      {/* Help chat floats above the tab bar; hidden on full-screen flows (reporting, paying, statements). */}
      {bar && <HelpChat bottom={88} suggestions={surface === 'officer' ? OFFICER_QUESTIONS : undefined} />}
    </>
  );
}

function Tab({ href, icon, label, match }: { href: string; icon: string; label: string; match?: string }) {
  const path = usePathname();
  const active = path === href || (match ? path.startsWith(match) : false);
  return (
    <Link href={href} aria-current={active ? 'page' : undefined}>
      <Icon name={icon} filled={active && icon !== 'activity' && icon !== 'history'} />
      {label}
    </Link>
  );
}

/** Citizen bar of five: Home, Learn, SOS (raised), Activity, Profile (Design Brief; C7: "Profile"). */
function CitizenBar() {
  return (
    <div className="tabbar">
      <nav aria-label="Main">
        <Tab href="/home" icon="home" label="Home" />
        <Tab href="/learn" icon="learn" label="Learn" match="/learn" />
        <Link href="/report" className="center" aria-label="SOS, report an emergency">
          SOS
        </Link>
        <Tab href="/activity" icon="activity" label="Activity" match="/reports" />
        <Tab href="/profile" icon="user" label="Profile" match="/profile" />
      </nav>
    </div>
  );
}

/** Officer bar (C1): Home, History, Report (raised), Wallet, Profile. */
function OfficerBar() {
  return (
    <div className="tabbar">
      <nav aria-label="Main">
        <Tab href="/officer" icon="home" label="Home" />
        <Tab href="/officer/history" icon="history" label="History" match="/officer/history" />
        <Link href="/officer/report" className="center" aria-label="Report from the field">
          <Icon name="plus" size={28} />
        </Link>
        <Tab href="/officer/wallet" icon="wallet" label="Wallet" match="/officer/wallet" />
        <Tab href="/officer/profile" icon="user" label="Profile" match="/officer/profile" />
      </nav>
    </div>
  );
}

export function Header({ title, back = true, children }: { title?: string; back?: boolean | string; children?: React.ReactNode }) {
  const router = useRouter();
  return (
    <header className="header">
      {back && (
        <button className="back" type="button" aria-label="Back" onClick={() => (typeof back === 'string' ? router.push(back) : router.back())}>
          <Icon name="back" />
        </button>
      )}
      {title && <h1>{title}</h1>}
      <span className="spacer" />
      {children}
    </header>
  );
}

export function useToast(): [string | null, (m: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3000);
    return () => clearTimeout(t);
  }, [msg]);
  return [msg, setMsg];
}

export function Toast({ msg }: { msg: string | null }) {
  return msg ? (
    <div className="toast" role="status" aria-live="polite">
      {msg}
    </div>
  ) : null;
}

/** For pages specified in the docs but not built yet — honest, not a dead end. */
export function NotBuilt({ title, note }: { title: string; note?: string }) {
  return (
    <main className="app">
      <Header title={title} />
      <div className="card empty">
        <strong>Coming next</strong>
        {note ?? 'This screen is specified in the design docs and comes in a later step.'}
      </div>
    </main>
  );
}
