// Public landing page for SSS (See Something, Say it): what it does, and where each kind of user signs in.
// Citizens and officers sign in here in the app; station, agency and platform staff go to the dashboard.
import Link from 'next/link';
import { Icon } from './Icon';
import '@/app/landing.css';

/** Where staff sign in. Set NEXT_PUBLIC_DASHBOARD_URL at build time; the default is the local dashboard. */
const DASHBOARD_URL = (process.env.NEXT_PUBLIC_DASHBOARD_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const STAFF_SIGN_IN = `${DASHBOARD_URL}/sign-in`;

const STEPS = [
  { icon: 'robbery', title: 'Report in two taps', text: 'Press SOS or choose what is happening. Add a photo, video or voice note if it is safe.' },
  { icon: 'pin', title: 'Routed by postcode', text: 'Your building’s NIPOST postcode sends the report to the nearest station that can respond.' },
  { icon: 'eye', title: 'Follow help to your door', text: 'See who accepted, how far away they are and when they arrive. Then rate the response.' },
] as const;

const REPORTS = [
  { icon: 'fire', tone: 'emergency', title: 'Emergencies', text: 'Fire, robbery, medical, kidnapping, accident. The nearest officers are offered the report in seconds.' },
  { icon: 'tip', tone: 'warning', title: 'Tips', text: 'Tell an agency what you know, with or without your name. A bounty is paid when a tip leads to a result.' },
  { icon: 'road', tone: 'signal', title: 'Public issues', text: 'Bad roads, broken street lights, flooding. Neighbours add their voice and you see when it is fixed.' },
  { icon: 'flag', tone: 'success', title: 'Stolen items', text: 'Register your phone, car or laptop. Report it stolen in two taps and follow the recovery.' },
] as const;

const STAFF = [
  'Live queue and map for every station',
  'Reports filtered by state, LGA, district, area and building',
  'Statements signed on the phone, sealed and searchable',
  'Cameras, street lights, drones and body cams in one control centre',
] as const;

function Logo() {
  return (
    <span className="lp-logo" aria-label="SSS, See Something, Say it">
      <span className="lp-logo-mark" aria-hidden>
        SSS
      </span>
      <span className="lp-logo-text">See Something, Say it</span>
    </span>
  );
}

function Phone({ src, alt, className = '' }: { src: string; alt: string; className?: string }) {
  return (
    <span className={`lp-phone ${className}`}>
      <img src={src} alt={alt} width={560} height={1212} loading="lazy" />
    </span>
  );
}

export function Landing() {
  return (
    <div className="lp">
      <header className="lp-nav">
        <div className="lp-wrap lp-nav-row">
          <Logo />
          <nav aria-label="Sections" className="lp-nav-links">
            <a href="#how">How it works</a>
            <a href="#report">What you can report</a>
            <a href="#check">Check before you buy</a>
            <a href="#agencies">For agencies</a>
          </nav>
          <div className="lp-nav-cta">
            <a className="lp-nav-staff" href={STAFF_SIGN_IN}>
              Staff sign in
            </a>
            <Link className="btn primary small" href="/sign-in">
              Sign in
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section className="lp-hero">
          <div className="lp-wrap lp-hero-grid">
            <div>
              <p className="lp-eyebrow">
                <span className="lp-live" aria-hidden /> Emergency response, built on the NIPOST digital postcode
              </p>
              <h1>
                See something. <span>Say it.</span> Help is on the way.
              </h1>
              <p className="lp-lead">Report an emergency in two taps, and follow help to your exact building. One app for citizens, officers, stations and agencies.</p>
              <div className="lp-cta-row">
                <Link className="btn primary" href="/sign-in">
                  Get started
                </Link>
                <a className="btn" href={STAFF_SIGN_IN}>
                  Staff sign in
                </a>
              </div>
              <a className="lp-112" href="tel:112">
                <Icon name="phone" size={18} /> In danger now? Call 112
              </a>
            </div>
            <div className="lp-hero-art" aria-hidden={false}>
              <span className="lp-glow" aria-hidden />
              <Phone src="/landing/phone-home.webp" alt="The SSS home screen with the SOS button" className="lp-front" />
              <Phone src="/landing/phone-track.webp" alt="Tracking the officers on the way to a report" className="lp-back" />
            </div>
          </div>
        </section>

        <section id="how" className="lp-section">
          <div className="lp-wrap">
            <h2>How it works</h2>
            <ol className="lp-steps">
              {STEPS.map((s, i) => (
                <li key={s.title} className="lp-card">
                  <span className="lp-step-no">{i + 1}</span>
                  <span className="lp-badge">
                    <Icon name={s.icon} size={24} />
                  </span>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="report" className="lp-section">
          <div className="lp-wrap">
            <h2>What you can report</h2>
            <p className="lp-sub">Each report goes to the agency that handles it, and you see every update.</p>
            <ul className="lp-tiles">
              {REPORTS.map((r) => (
                <li key={r.title} className="lp-card" data-tone={r.tone}>
                  <span className="lp-badge">
                    <Icon name={r.icon} size={24} />
                  </span>
                  <h3>{r.title}</h3>
                  <p>{r.text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="check" className="lp-section">
          <div className="lp-wrap lp-split">
            <div className="lp-split-art">
              <Phone src="/landing/phone-check-stolen.webp" alt="A check result: reported stolen, do not buy" className="lp-front" />
              <Phone src="/landing/phone-items.webp" alt="My items: registered phones and laptops" className="lp-back" />
            </div>
            <div>
              <p className="lp-eyebrow">Stolen items</p>
              <h2>Check before you buy</h2>
              <p className="lp-sub">Buying a used phone, car or laptop? Enter its IMEI, chassis number or serial number first.</p>
              <ul className="lp-points">
                <li>
                  <Icon name="check" size={20} />
                  <span>
                    <strong>Buyers</strong> know before they pay, and the check is kept on record with a reference.
                  </span>
                </li>
                <li>
                  <Icon name="check" size={20} />
                  <span>
                    <strong>Owners</strong> register items with a receipt, report a theft in two taps and are told when someone checks the item.
                  </span>
                </li>
                <li>
                  <Icon name="check" size={20} />
                  <span>
                    <strong>Police</strong> get the place of every matched check, so stolen goods become hard to sell.
                  </span>
                </li>
              </ul>
              <Link className="btn signal" href="/sign-in">
                <Icon name="search" size={20} /> Sign in to check an item
              </Link>
            </div>
          </div>
        </section>

        <section id="agencies" className="lp-section">
          <div className="lp-wrap lp-split reverse">
            <div>
              <p className="lp-eyebrow">For stations and agencies</p>
              <h2>One command view, from report to resolution</h2>
              <ul className="lp-points">
                {STAFF.map((t) => (
                  <li key={t}>
                    <Icon name="check" size={20} />
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
              <a className="btn" href={STAFF_SIGN_IN}>
                <Icon name="lock" size={20} /> Staff sign in
              </a>
            </div>
            <div className="lp-screen">
              <img src="/landing/dash-station.webp" alt="The station dashboard: live queue, map and incident detail" width={1500} height={938} loading="lazy" />
            </div>
          </div>
        </section>

        <section id="sign-in" className="lp-section">
          <div className="lp-wrap">
            <h2>Sign in</h2>
            <p className="lp-sub">Choose how you use SSS.</p>
            <div className="lp-doors">
              <Link className="lp-card lp-door" href="/sign-in">
                <span className="lp-badge">
                  <Icon name="user" size={24} />
                </span>
                <h3>Citizens</h3>
                <p>Sign in with your phone number. New here? The same step creates your account.</p>
                <span className="lp-door-go">
                  Continue with phone <Icon name="chevron" size={18} />
                </span>
              </Link>
              <Link className="lp-card lp-door" href="/sign-in">
                <span className="lp-badge">
                  <Icon name="shield" size={24} />
                </span>
                <h3>Officers</h3>
                <p>Use the phone number your station registered. You go straight to your duty screen.</p>
                <span className="lp-door-go">
                  Officer sign in <Icon name="chevron" size={18} />
                </span>
              </Link>
              <a className="lp-card lp-door" href={STAFF_SIGN_IN}>
                <span className="lp-badge">
                  <Icon name="lock" size={24} />
                </span>
                <h3>Station, agency and platform staff</h3>
                <p>Sign in to the dashboard with your phone and the code from your authenticator app.</p>
                <span className="lp-door-go">
                  Open the dashboard <Icon name="chevron" size={18} />
                </span>
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-wrap lp-footer-row">
          <Logo />
          <span className="lp-footer-note">False alarms delay real help. In immediate danger, call 112.</span>
        </div>
      </footer>
    </div>
  );
}
