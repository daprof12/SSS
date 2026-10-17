# ERP — Emergency Response Platform (foundation)

The foundation from `document/UX Gap Analysis.md` (readiness gate) and `document/Report Tracking and Data Flow.md`. Providers are mocked; screens beyond the dashboard shell come next.

## Run it

Needs Node 20+ and Docker.

```bash
npm install
npm run db:up          # PostgreSQL 16 + PostGIS on localhost:54329
npm run db:migrate
npm run build:packages # tokens + domain
npm run dev:api        # http://localhost:4000
npm run dev:dashboard  # http://localhost:3000 → station, agency, admin
npm run dev:mobile     # http://localhost:3001 → citizen and officer app (PWA)
npm test               # all suites (the API suite resets the local database)
```

## Layout

| Path | What it is |
|---|---|
| `packages/tokens` | Design tokens → `tokens.css` (dark, light, system, reduced motion), `tokens.dart` for Flutter, `tokens.json`. Tests enforce WCAG AA on 21 colour pairs in both themes. |
| `packages/domain` | Pure TypeScript: state machines for incident, report delivery, subscription, withdrawal, tip, invite, technician job and fine; citizen tracking copy for every state; role‑filtered incident views; money rules. |
| `db/migrations` | Schema: identity, places, agencies, incidents, money, devices. The database itself enforces append‑only logs, a hash‑chained audit log, balanced ledger journals, and safety notifications that can't be switched off. |
| `apps/api` | NestJS: auth guard (staff need 2FA), incident lifecycle with timers, live SSE stream per role, fund‑wallet flow with signed webhooks, KYC, emergency contacts, places, deletion check. |
| `apps/dashboard` | Next.js: rail + top bar, theme switch saved to the account, My profile, live incident queue and detail, station action sheets. |
| `apps/mobile` | Next.js PWA for citizens and officers (Flutter later, per TRD). Installable, offline page, offline report queue with SMS fallback. |
| `packages/web-ui` | Shared React pieces used as source by both web apps: API client, theme, Sheet, ThemeSwitch, StateChip, CloseReportSheet. |

## Decisions applied

- C1–C9 as recommended in the gap analysis (officer bar + panic action, phone OTP first, 5 s ring + 30 s free cancel, decline reason always required, technician as a 7th role, …).
- Billing starts at install: the schema refuses an active subscription without `period_start`.
- Emergency contacts see the area only; at most 3 contacts; off by default for violence reports and in discreet mode.
- Account deletion is blocked until wallet, fines, withdrawals and subscription are settled.
- Token fixes: white on dark‑mode emergency red is 3.48:1, so primary buttons use `actionPrimary` #E11D48. Light Signal is #0E7490 and light Success text is #047857.

## Mocked — swap before pilot

| Adapter | File | Real provider |
|---|---|---|
| Postcode | `apps/api/src/adapters/postcode.ts` | NIPOST API (endpoints still to come) |
| KYC | `apps/api/src/adapters/kyc.ts` | Smile ID / Dojah pilot |
| Payments | `apps/api/src/adapters/payments.ts` | Paystack (signature check already matches Paystack's HMAC‑SHA512) |
| SMS | `apps/api/src/adapters/sms.ts` | SMS provider with registered sender ID |

Dev‑only endpoints under `/dev` (seed, tokens, simulated Paystack completion, SMS outbox, postcode outage) exist only when `NODE_ENV` is not `production`; config refuses `DEV_TOOLS=1` in production.

## Known foundation limits

- Timers (cancel window, offer expiry) and the event bus are in‑process. They must move to a durable queue (TRD: NATS/Kafka) before more than one API instance runs.
- The SSE stream takes the token as a query parameter because EventSource can't send headers. Replace it with a short‑lived single‑use stream ticket before production, so tokens don't land in access logs.
- Dev sign‑in issues HS256 tokens; production uses the OIDC provider.
- Routing escalates within the same station; "next station" overflow, the AI brief, clips and the remaining dashboard pages come next.

## Agency onboarding and subscription (UX Gap Analysis §10)

The 11-stage lifecycle runs on `agencyMachine` and `agencyInvoiceMachine` in `packages/domain/src/agency.ts`; migration `006_agency_lifecycle.sql` adds plan/add-on selection, PO numbers, invoice payments (Paystack or a bank transfer that finance marks), inventory, messaging usage, per-agency price overrides and the single setup checklist (`agency_setup_checklist()`). Prices, VAT, due days and the second-approval threshold are placeholders: fee rows in the migration, the rest in `AGENCY_BILLING` (`apps/api/src/agencies/billing.service.ts`). Every money or approval action writes the audit log.

**Agency side.** The contact person needs two-step login. Agency staff are checked against `user_roles` in the database, so a role granted at registration works without a new token.

| Stage | Endpoint |
|---|---|
| 1 Register | `GET /agencies/directory` · `POST /agencies/register` · `GET /me/agencies` |
| 2–3 Documents, status | `POST /agencies/:id/documents` (metadata + mock upload URL) · `POST /agencies/:id/submit` · `GET /agencies/:id` (timeline, review comment, banner, buttons) |
| 4 Choose plan | `GET /agencies/:id/plans` · `POST /agencies/:id/plan` → onboarding invoice (fee + first period + VAT) |
| 5 Pay | `POST /agencies/:id/invoices/:invoiceId/pay` (Paystack, `Idempotency-Key` required) · `POST …/pay-by-invoice` (PO number → proforma + dedicated account, "Waiting for payment") |
| 6 Set up | `GET /agencies/:id/setup` · `POST /agencies/:id/stations` · `PATCH …/stations/:sid` (head) · `PUT …/stations/:sid/areas` · `POST …/stations/:sid/officers` · `POST /agencies/:id/payout-account` · `POST /agencies/:id/inventory` |
| 7 Go live | `POST /agencies/:id/go-live` (needs required checklist steps 1–4). Each station goes live once it has a head, an area and an on-duty verified officer. |
| 8 Invoices | `GET /agencies/:id/invoices` · `GET /agencies/:id/invoices/:invoiceId` |
| 10 Change plan | `POST /agencies/:id/plan/change` (`confirm: false` previews the new monthly amount; upgrades apply now with a prorated invoice, downgrades at period end) |
| 11 Offboard | `POST /agencies/:id/offboard` (creates the bounty-pool payout) · `GET /agencies/:id/offboard` (what is left to settle) |

**Platform side** (`platform_admin`).

| Purpose | Endpoint |
|---|---|
| Review | `GET /admin/agencies` (waiting by default, or `?status=`) · `GET /admin/agencies/:id` · `POST /admin/agencies/:id/decision` (`approve` · `ask_more` + comment · `reject` + reason) |
| Fee override | `PUT /admin/agencies/:id/prices/:code` (reason required) |
| Finance | `GET /admin/invoices` (dunning list, overdue first) · `POST /admin/invoices/:id/mark-paid` (bank reference, part payments allowed) · `POST /admin/invoices/:id/waive` (reason; second, different approver above the threshold) |
| Payouts | `POST /admin/payouts/:id/approve` (verified account; second approver above the threshold) |
| Jobs | `POST /admin/billing/generate-invoices` and `POST /admin/billing/mark-overdue` with `{ asOf: 'YYYY-MM-DD' }`. Both are safe to rerun: one invoice per period, each reminder once. |
| Offboard | `POST /admin/agencies/:id/offboard/approve` (only once nothing is left to settle; pauses stations, takes officers off duty, keeps records) |

**Overdue never stops dispatch.** Routing takes stations of agencies that are `live`, `overdue` or `offboarding` (`dispatchingAgencyStates`). While an agency is overdue, adding stations, inventory or plan upgrades returns `402 billing_hold` ("New stations and equipment are on hold until you pay."). Paying the last overdue invoice restores the agency right away.

**Not built yet:** auto-charging a saved card (agencies pay each invoice), receipt PDFs, credit notes (the machine has `credit`), funding the bounty pool, officer invites (officers are added directly, verified when their KYC is), and records export at offboarding. The Paystack subaccount is mocked. Run the billing jobs from a scheduler once the durable queue exists.

## Phase 1 dispatch backend

| Area | Endpoint | Notes |
|---|---|---|
| Officer duty | `PATCH /me/officer/duty` | On duty needs a verified badge and location; off duty is blocked during an active incident, and open offers are re-routed straight away |
| Officer location | `POST /me/officer/location` | Recomputes the citizen's ETA while en route (30 km/h urban estimate until a routing provider is connected); logs moves of 5+ minutes |
| Officer Home | `GET /me/officer/home` | Duty banner, today's totals, Offers / Active / Team / Done tabs with the States doc empty messages |
| Station | `POST /incidents/:id/assign`, `GET /me/station/officers`, `GET /me/station/transfer-targets` | Feed the dashboard action sheets |
| Rating | `POST /incidents/:id/rating` | After close, once per reporter or joiner; 1–5 stars, fixed tags, comment ≤ 1000; the officer is told |
| Notifications | `GET /me/notifications?tab=all\|reports\|money\|account`, `POST /me/notifications/:id/read`, `POST /me/notifications/read-all` | In-app copies for 30 days. Written in the same transaction as each state change; discreet reports get neutral wording |

**Overflow:** if nobody at the nearest station is free, the report moves to the routing rule's fallback station, else the nearest eligible one not yet tried, and the first station's head is told. If every station is out, it goes back to the station covering the area and the heads of every station tried get "Nobody accepted".

**Not built yet:** push, SMS and WhatsApp delivery (only in-app rows are written), and rewards paid from ratings.

## Citizen and officer app (PWA)

One installable app; the signed-in person decides the surface. Sign in with a demo citizen or officer at `/sign-in`.

| Citizen | Officer |
|---|---|
| Home: SOS, quick types, live-report bar, home building line | Home: duty toggle (real GPS, dev fallback), today's totals, Offers / Active / Team / Done |
| Report: type → confirm → 5 s cancel ring synced with the server window | Offer: full screen, countdown ring (amber at 10 s, red at 5 s), Accept or Decline with a reason |
| Live status over SSE: map, status from the domain copy, six steps, freshness line, officer card, add info, cancel with reason | Incident: next action first (on my way → on scene → close), notes, request help, hold-to-send panic, location pings that move the citizen's ETA |
| Rate the response, then after-care | Wallet (no Fund — officers pay nothing), Profile |
| Activity, notifications, wallet with fund flow, emergency contacts, home place, appearance | Notifications |

**Offline:** a report made without a connection is saved with its client reference and sent when the phone reconnects (the server de-duplicates on the reference). The screen offers "Send by SMS now" and "Call 112". The service worker is registered in production builds only; it caches pages network-first and never caches the API. The SMS short code is a placeholder (`NEXT_PUBLIC_SMS_NUMBER`).

**Test-only screens:** while Paystack is mocked, `/pay/[ref]` stands in for the hosted checkout and the transfer screen has a "simulate arrival" button. Both are hidden in production builds.

**Not built yet** (rows say "Soon" or open a "Coming next" page): Learn, tips, donations, withdraw, security, discreet mode, language, officer history and field reports, protected calling and messaging, photos and voice notes.

## Sign-in and onboarding

Phone first (C6). `POST /auth/otp/start` sends a 6-digit code by SMS; `POST /auth/otp/verify` signs in, creating a citizen account on first use. Codes are stored only as a keyed hash (`OTP_SECRET`), expire in 5 minutes, allow 5 tries (C3), and can be re-sent after 60 seconds; there are hourly caps per phone and per IP, and the reply is the same for new and existing numbers.

Sessions: a 15-minute access token plus a refresh token that rotates on every use (`POST /auth/refresh`). Every request checks the session is still live, so `POST /auth/sign-out` or revoking a device (`GET /auth/sessions`, `DELETE /auth/sessions/:id`) takes effect at once. The shared client refreshes silently and signs out cleanly when refresh is refused.

The PWA's `/welcome` flow resumes where it stopped: name → 5-card tour (skippable) → location and notification priming → KYC (NIN/BVN + selfie; skippable, AUTH-4) → home building → done. After KYC the name is locked to the ID.

**Staff:** phone OTP is one factor, so officers and other staff stop at "Two-step login" until the authenticator step is built; use `/sign-in/demo` in development. **Not built yet:** authenticator 2FA and recovery codes, PIN, the "SOS without an account" path, and replaying the tour from settings.

## Tips and public issues

**Report a tip** (Rewards doc; Report Tracking B2): pick a category (13, each with its receiving agency), keep your name from the agency (on by default), see the agency's bounty range, describe it, optionally add a place, send. Urgent wording or an emergency category points to SOS. The tip detail shows Received → Sent to agency → Verified result → Bounty paid, the agency's questions, "Add more information" and "Withdraw this tip".
Agency side (`/agencies/:id/tips`, `…/tips/:tipId/actions`): the queue shows "Anonymous tipper T-…" unless the tipper agreed; ask for more, record a result (suggested bounty from the rate), approve (cap, staff conflict and pool checks; paid from the bounty pool into the tipper's wallet, held 7 days), decline with a reason, close, or mark false (trust −10, appealable).

**Public issues** (Public Issues doc §1–2; B3): pick one of 8 categories, place (GPS first, home or postcode), what it is, how bad, a few words, optional anonymity. Before sending, the form shows how many people already reported it within 100 m; reports there join the same case, and one person counts once. The case shows the count, Sent → Taken on → Work started → Fix reported → Fixed, and asks reporters "Is it fixed?": enough "yes" closes it, one "no" reopens it and every reporter answers again next round.
Agency side (`/agencies/:id/issues`, `…/issues/:caseId/actions`): assign with a target date, start, mark fixed with a note. Reporters are told at each step.

Both are linked from Home ("Not an emergency?"), the SOS type picker, Activity, Profile, and the officer's Report tab. Photo and video upload, the agency dashboard pages for these queues, the PDF brief and "send to a superior" link, and the 7-day silence rule that closes a fix are not built yet.
