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

**Not built yet:** auto-charging a saved card (agencies pay each invoice), receipt PDFs, credit notes (the machine has `credit`), officer invites (officers are added directly, verified when their KYC is), and records export at offboarding. The Paystack subaccount is mocked. Run the billing jobs from a scheduler once the durable queue exists.

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

**Not built yet** (rows say "Soon" or open a "Coming next" page): Learn, tips, donations, withdraw, security, discreet mode, language, officer history and field reports, protected calling and messaging, and voice notes.

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

Both are linked from Home ("Not an emergency?"), the SOS type picker, Activity, Profile, and the officer's Report tab. The agency dashboard pages for these queues are in `apps/dashboard/app/(app)/agency`.

## Photos, videos, scheduled rules and the issue brief

**Photos and videos** (`apps/api/src/media`, migration 009). There are two steps, so production can switch to presigned object-storage uploads: `POST /media` registers the type, size and owner, then `PUT /media/:id/content` sends the bytes. Each file:
- must be JPEG, PNG, WebP, MP4 or MOV, at most 10 MB, with at most 6 per person per report;
- is checked by its own header bytes, not its name or claimed type;
- has its EXIF/GPS segments stripped if it is a JPEG.

Who can see and add files:
- **Tips:** the tipper adds files while the tip is open; NAPTIP-side staff see them.
- **Issues:** any reporter adds until the issue is fixed; the agency sees them.
- **Live reports:** the reporter adds; assigned officers and the station head or dispatcher see them, and each upload adds "Photo added" to the response log and stream.

Every staff view is written to the audit log. Files are served `private, no-store`, and only with a session token. In the PWA, the issue form, a tip's "Add more information" and a live report's "Add info" all take photos and videos, with thumbnails, upload progress and a viewer. Development keeps the bytes in `media_blobs`.

**Scheduled rules** (`apps/api/src/jobs`). They run every 5 minutes in the API process, and on demand with `POST /admin/jobs/run`:
- **Fix silence:** if no reporter says "not fixed" within 7 days of "marked fixed", the issue closes as fixed (by system) and reporters are told.
- **Bounty release:** when a bounty's 7-day hold ends, the tip moves to "Ready to withdraw" and the tipper is told.

Both are safe to run twice and across instances (`skip locked`).

**Issue brief and share link** (`apps/api/src/reports/brief.*`):
- `GET /agencies/:id/issues/:caseId/brief.pdf` is a one-page PDF: facts, counts, a reports-per-day chart, what people report, and the history. Each download is logged.
- `POST …/shares {note, days 1–14}` returns a view-only link `/shared/<token>` for a superior or another office. Only the token's hash is stored. List links with `GET …/shares`; turn one off with `DELETE …/shares/:id`.
- The public page `apps/dashboard/app/shared/[token]` needs no sign-in, sends no referrer and is not indexed. It shows the agency's note, and counts and logs every view. After expiry or revoke it says "This link has expired."

Neither the PDF nor the link carries reporter names, ids or their free text.

On the dashboard, the agency's tip and issue pages show the reporter's photos and videos, with a full-screen viewer (arrow keys, Escape); each view is audited.

**Not built yet:** virus scanning and video length checks (needs the media worker).

## What each agency handles, bounty rates and the bounty pool

**Menus by agency kind.** `agencyHandles(kind)` in `@erp/domain` reads the tip and issue catalogues:
- **Bounties** shows when the agency receives tips. The pool and rates appear only when one of its tip categories pays a bounty.
- **Public issues** shows when it handles an issue category.

Examples: NAPTIP gets Bounties only, FERMA (roads) gets Public issues only, Police gets both, and a fire service gets neither. `/me/agencies` returns `handles`, and the API refuses a queue the agency does not handle with "Your agency does not handle public issues." (409). A page reached by link shows the same message, with the agency switcher.

**Bounty rates** (`PUT /agencies/:id/bounty-rates/:category`, agency admins only). Each rate is either fixed or tiered by result:
- tiered rates pay a standard amount, and a serious amount when the result is recorded as high severity;
- a cap is optional;
- a rate can be paused;
- it applies only to the bounty categories the agency receives.

Every change is audited. Citizens see the new range on the tip form at once.

**Funding the pool** (Rewards doc: "The agency funds a bounty pool in advance"):
- `POST /agencies/:id/bounty-pool/fund {amountKobo, method, idempotencyKey}` takes ₦10,000 to ₦50,000,000 per payment, by card, bank transfer or USSD through Paystack.
- The pool is credited only by the signed webhook: pool +, platform clearing −, balanced. Agency staff are notified, and a failed payment is reported too.
- `GET /agencies/:id/bounties/summary` gives what the Bounties page shows, as on the "Agency bounties" board: pool balance, claims waiting, paid this month, tips this month, the rates table, pool activity and payments still confirming. When the pool is below pending claims, the page warns "Pool has [Amount], below pending claims of [Amount]."
- In development, the fund sheet plays the Paystack checkout with "Pay now (test)" and "Decline card (test)".

**Percentage rates.** A rate can also be "Share of value recovered", which needs a percent (up to 50%) and a cap. The agency then enters the value recovered or seized when it records a result, and the suggested bounty is that share, never above the cap. Tippers see, for example, "5% of the value recovered, up to ₦1,000,000". `suggestBounty` and `bountyRangeText` in `@erp/domain` are the one rule used by the API and the dashboard.

**Paying the pool back when an agency leaves:**
- An agency cannot ask to leave while bounty claims are waiting for a decision. Once it has asked, the pool is closed: no funding and no new approvals.
- The request creates one payout for the pool balance. Platform admins approve it, two of them above ₦100,000 (`POST /admin/payouts/:id/approve`).
- On final approval, the pool is debited and a Paystack transfer is queued to the agency's verified account. The signed `transfer.success` webhook marks the payout paid. `transfer.failed` puts the money back in the pool, tells the agency, and keeps offboarding blocked until `POST /admin/payouts/:id/retry` succeeds.
- `GET /admin/payouts?state=` lists payouts for platform admins. The agency's Bounties page shows where its payout stands.
- In development, `POST /dev/paystack/transfer/:payoutId?outcome=success|failed` stands in for Paystack.

**Not built yet:** the platform fee of [%] on each bounty (still to be decided), and a platform admin screen for the payout queue (the API is there).
