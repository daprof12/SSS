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

**Not built yet** (rows say "Soon" or open a "Coming next" page): Donations, security (citizen), discreet mode, language, and protected calling and messaging.

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

**Admin: Donations and payouts** (`/admin/payouts`, from the States doc). The Payouts tab has:
- headline figures: waiting for approval, needs your approval, failed, paid this month;
- filters and a table;
- the "Payout detail" sheet: gross, Paystack's transfer fee, net to the bank, destination account, approvals and status.

On the sheet, a platform admin can:
- **Approve:** "Approve (1 of 2)" above ₦100,000; one person cannot approve twice.
- **Hold:** a note is required.
- **Release:** back to the approval queue, with earlier approvals cleared.
- **Retry:** for a failed transfer ("Retry or edit the bank details").

The recipient bears the transfer fee (decided 2026-10-18; `transferFee` in `@erp/domain`: ₦10 / ₦25 / ₦50 by amount), so the bank receives gross minus fee. The Donations tab is a placeholder until donations exist.

**Platform fee on bounties** (decided 2026-10-18, migration 011):
- Platform admins set a suggested fee (10% to start) and the range agencies may choose within (5–20% to start), on Admin → Settings (`GET/PUT /admin/settings/bounty-fee`).
- Each agency uses the suggestion, or picks its own within the range from its Bounties page (`PUT /agencies/:id/bounty-fee {bps | null}`).
- If the range later excludes an agency's choice, the nearest limit applies, and the admin page lists those agencies.
- On approval the fee is charged to the agency's pool on top of the bounty, so the tipper gets the full amount. It goes to a separate `platform_fees` wallet in the same balanced journal, and the claim records `fee_bps` and `fee_kobo`.
- The approve sheet shows the amount to the tipper, the fee, and the total from the pool. Waiting claims, the "Pool low" check and pool activity all include the fee.

**Not built yet:** the "Bounty and wallet oversight" tabs (Pools, Claims, Disputes, Ledger, and the Paystack mismatch check).

## Picking a building, and voice notes

**Pick your building** (`components/reports/BuildingPicker.tsx`). Wherever a report asks "Where", the user picks a building's NIPOST digital postcode on the map instead of typing one:
- It finds the user's location and shows a satellite map (or street map) with the GPS accuracy circle and a search circle. A slider sets the search radius, 25–250 m (NIPOST's cap).
- Every building with a postcode in the circle has a label. Labels that would overlap become small dots that can still be tapped, and a list view gives the same choices.
- Tapping a building selects it and shows the postcode with a copy button. "Use this spot" sends the map point without a postcode when the building has none yet. Tapping open ground moves the search there.
- `GET /places/within?lat&lng&radius` returns the buildings, nearest first, through the postcode adapter's new `within()`.

The mock adapter places a stable building on most cells of a ~28 m grid around any point, so the picker works anywhere in development. Its postcodes encode their cell (e.g. `LA 0KDI 0ACF`), so lookups and reports resolve them. Map tiles are Esri World Imagery and World Street Map until a maps provider is chosen; `NEXT_PUBLIC_TILES_SATELLITE` and `NEXT_PUBLIC_TILES_MAP` swap them.

**Voice notes** (migration 012). Alongside photo and video, "Voice note" records with the microphone:
- WebM/Opus on Chrome and Android, MP4/AAC on Safari and iOS.
- A live timer and level bars, cancel and done, and an automatic stop at 2 minutes.
- Tap a voice tile to hear it before sending.

The API takes `audio/webm`, `audio/mp4`, `audio/ogg` and `audio/mpeg`, checks the container from the file's bytes, and stores the length. A note on a live report adds "Voice note added" to the response log. Voice notes play back on the citizen's report, the officer's incident and the agency's tip and issue pages.

The same picker opens wherever a place is set, and no screen asks anyone to type a postcode:
- "Where I am now" on the emergency "Where is it happening?" sheet, which keeps "Use this spot" because an emergency can't wait for a postcode.
- Home and places, and the onboarding "Where do you live?" step. These open as "Pick your home" without "Use this spot", since a home must be a building.

The new-tip form now takes photos, video and voice notes too; they upload after the tip is created. My tips and My public issues go back to Activity.

## Learn

The citizen Learn tab follows the six Learn boards. Admins publish through Admin → Learn feed (migration 013, `apps/api/src/learn`).

**For you** is a full-screen swipe feed, one lesson per screen:
- **Formats:** videos, articles shown as an excerpt with "Read the article", and quizzes answered on the card.
- **Lesson cards:** source, title, caption and why it was shown ("Because you picked Fire safety", "Shown because you watch Fire safety"). The side rail has like with a count, save, share and more ("Not interested" mutes that topic).
- **Ranking:** interests and watch history pull a lesson up; languages, freshness and already-seen lessons push it down.
- **Seen and progress:** a lesson counts as seen after 1.5 s on screen, and progress is reported every 10 s. The feed ends with "You are all caught up".
- **First visit:** the person picks at least 3 interests and their languages, or skips for now.

**General** has:
- search and the filter sheet: format, topic, language, length, source and sort, with a live "Show [n] results";
- format chips, including Saved;
- "Your interests" with Edit;
- "Browse topics" with counts, opening topic pages.

**Search** suggests as you type and has Top, Videos, Articles, Quizzes and Agencies tabs.

**Lesson pages** (`/learn/p/:id`): video, article (reading to the end counts as done) or quiz, with like, save and share.

Quizzes are marked on the server; the phone never receives the answers. Lessons with no footage play as step cards with story-style progress bars, built from their steps.

**Admin Learn feed** (`/admin/learn`):
- Tabs: Live, In review, Drafts, Removed, with counts.
- New post: format, title, topic, language, from (platform team or an agency), show to (everyone or one state), video or image upload through the checked media pipeline, caption, and an article body or quiz builder.
- Workflow: draft → in review → live. A different admin must approve, enforced in the API and the database. Sending back and removing need a note, and every step is audited.

Development seeds 12 real lessons in English and Pidgin.

**Not built yet:** comments on lessons, the AI suggestions for the feed (AI and LLM page), a reminder notification for new lessons, and video transcoding (uploads are capped at 10 MB until the media worker exists).

## Officer app: History, Team, Profile and field reports

These follow the officer boards (`apps/api/src/officers/work.*`, migration 014). "Team" is the officer's station.

- **History:** the station's closed responses from the last 90 days, with stats (responses, my rating, team rating) and filters (All, Mine, Team, This month). Each row shows the type and postcode, who responded ("You" first) and the rating.
- **Activity detail:** date, arrival time, reports merged and outcome. Each officer on the team appears with their role (Lead or Support), rating and any reward. Below that, the citizen's comment and the reward-split note once rewards are paid.
- **Team** has three tabs:
  - **Members:** duty status, with "back" times from the roster.
  - **Shifts:** the next 7 days of `duty_shifts`.
  - **Activity:** accepts, arrivals and closings over the last week.
  - The stats show team rating, responses and average arrival.
- **Profile:** the board's rating card, with sub-scores (arrival speed, care and manner, communication) derived from citizens' rating tags by `subRatings` in `@erp/domain`. It also has the team card, wallet, rewards and donations, bank account, tips, theme, and these rows:
  - **Documents and badge:** status, expiry, and what citizens see.
  - **Duty and shifts:** the next two weeks.
  - **Dispatch alerts:** opens the notification settings.
  - **Security:** two-step status, signed-in devices and signing out others.
  - **Help.**
- **Report (the + tab):** an incident report from the field. It has the type grid, location from GPS or the building picker, the description, photos, video, voice notes and "Link to incident". A link is limited to incidents the officer is on or closed that day, and adds "Field report added" to that incident's log. "Tip, earn a bounty" switches to the tip form. The officer's past field reports are listed below. The station head and dispatchers can see field reports and their files.

Development seeds a week of demo shifts for both officers.

**Not built yet:** rewards paid from ratings (the detail shows them once they exist), a station-dashboard view of field reports, and teams smaller than a station.

## Withdrawals (citizens and officers)

Wallet → Withdraw, and Wallet → Bank account (`apps/api/src/wallet/withdrawals.service.ts`, migration 015). One flow serves both apps.

**Bank account:**
- A bank (Paystack codes in `NIGERIAN_BANKS`) and a 10-digit account number.
- The account is looked up as soon as it is complete, and the bank's name for it is shown.
- It is saved only when it matches the verified name from the identity check ("This account name does not match your verified name."). Officers' ranks are not part of that name.
- Changing it needs the PIN, is blocked while a withdrawal is in progress, and sends a security notification.

**PIN:**
- 4 digits, set in the flow and entered twice. Same-digit and in-a-row PINs are refused.
- 5 wrong tries lock it for 30 minutes. Wrong tries are counted outside the transaction.
- It is stored as a salted, peppered scrypt hash.

**Withdrawing:**
- **Amount:** quick amounts and All. The quote applies the minimum, the available balance (held bounties and rewards excluded) and the daily limit, using the States doc messages.
- **Confirm:** "Withdraw [Amount] to [Bank], ending [0000]? It arrives within 24 hours." with the transfer fee (the recipient bears it, as for payouts), then the PIN pad.
- **First withdrawal:** the first one to an account waits 24 hours as "Scheduled". The scheduled job then sends it.
- **Later withdrawals:** sent at once.
- **Ledger:** the wallet is debited when the withdrawal is requested.
- **Paystack:** the signed `transfer.success` marks it arrived ("[Amount] reached [Bank].") and trusts the account. `transfer.failed` refunds it in the same balanced journal ("Your withdrawal failed and the money is back in your wallet.").
- Repeat requests with the same idempotency key are ignored, and every step is audited.

**Development:**
- The mock bank lookup returns the verified name for any number, someone else's name for numbers ending 0000, and "not found" for numbers ending 9999.
- `POST /dev/paystack/withdrawal/:id?outcome=success|failed` stands in for the transfer webhook.

**Forgot PIN** (migration 016). "Forgot PIN?" on any PIN pad sends a 6-digit code by SMS to the account's own phone:
- **Code rules:** the same limits as sign-in codes: 5 minutes, 5 tries, a 60-second resend and an hourly cap.
- **New PIN:** entered twice. A weak PIN is refused before the code is used.
- **Lock:** the reset works while the PIN is locked, and clears the lock.
- **24-hour hold:** withdrawals in the next 24 hours are held as "Scheduled", which protects against a stolen SIM, and the owner gets a notice. Codes have a purpose, and sign-in only accepts sign-in codes.

**Not built yet:** a real Paystack adapter (resolve, recipients, transfers), and an admin view of withdrawals.

## Rewards for rated responses

When a citizen rates a closed response, the platform rewards pool pays the officers on it. Each incident is decided once, on its first rating (migration 017: `reward_rules`, `reward_payments`).

- **The agency's rule** (Dashboard → Payouts, agency admin): the reward for 5 stars (up to ₦25,000), what 4 stars earns as a percentage, and the split: the lead officer takes half and the rest share the other half (`lead_first`), or everyone gets the same (`equal`). Any remainder goes to the lead. 3 stars or fewer earn nothing. Rewards can be paused.
- **Held days:** each share goes into the officer's wallet held for 7 days (`available_at`), then it can be withdrawn. The officer gets a notification ("You earned ₦X for a N-star response. It is released on D."), and History shows the reward next to the response.
- **Anti-gaming:** nothing is paid when the reporter is staff, when the same person has rated the same station more than 3 times, when an officer has reached ₦20,000 for the day, or when the pool is empty. The reason is shown in Recent rewards.
- **Donation shares:** the agency also sets how future donations split between officer, station and agency (must total 100%). Gifts to a named officer go to that officer.

API: `GET /agencies/:id/rewards`, `PUT /agencies/:id/reward-rule`, `PUT /agencies/:id/donation-shares`. The dev seed sets a ₦5,000 police rule and funds the pool with ₦500,000. Tests: `apps/api/test/rewards.e2e.test.ts`.

## Citizen profile and home

Migration 018. API in `apps/api/src/citizen/`; tests in `apps/api/test/citizen.e2e.test.ts`.

- **Security** (`/profile/security`):
  - Two-step login on and off with an SMS code.
  - 10 recovery codes, shown once.
  - The 4-digit PIN, set or changed, with a forgotten-PIN reset.
  - Face or fingerprint choices; payments always ask.
  - Trusted devices and active sessions.
- **Discreet mode** and **Language** save to the account. Screens are still English; translations are not in yet.
- **Help and support**: answers, 112, and messages to the team with an `S-` reference.
- **Donations** (`/donate`):
  - To an agency, a station or an officer who helped you; ₦500, ₦1,000, ₦2,000 or another amount.
  - Pay from the wallet (PIN) or by Paystack card, transfer or USSD.
  - Gifts to an officer are held 7 days.
  - A station gift is split by the agency's donation shares: the officer part shared between the station's officers, the rest to the station and agency wallets.
- **Payments and receipts** (`/payments`): every payment with an `R-` receipt. Paystack payments wait for the webhook.
- **Fines and appeals** (B8):
  - A report closed as unfounded gives the reporter a warning first (trust −5).
  - The next one within 180 days is a ₦5,000 fine (trust −10), appealable within 14 days. Appeals need at least 20 characters and can include photos.
  - Pay from the wallet or by Paystack, but not while an appeal is open.
  - Admin → Fines and appeals waives (trust given back), reduces or upholds, each with a reason.
- **Home** (`/profile/home`):
  - **Household:** invite by phone, with what members may do (live cameras, alerts, report for the home). Someone already in a household is refused by name.
  - **Devices:** live status, the offline-camera checklist, camera settings and clips, and the street-light "light up for 1 hour" (2 a night).
  - **Repairs:** report a device problem; damage is urgent and the nearest station is told.
  - **Repair status:** received → fault confirmed → visit booked → fixed (the owner confirms).
  - The admin Installation team page confirms the fault, books a technician and window, and marks it fixed.
  - The dev seed gives Ada a Household plan with 2 cameras and 2 street lights.
- **Officer dispatch:**
  - Offers never go back to an officer who declined or missed one.
  - `GET /incidents/:id/offer` says whether an offer is open, accepted, declined, missed, taken or withdrawn.
  - Missed and declined offers count in the acceptance rate shown on the officer profile.
  - The response log shows who did each step.
  - Officers can add notes and photos (staff-only), request a drone or a transfer (the station head is told), and hand a report over before arriving.

## Statements, false-alarm review, donation fee, help replies

Migration 019. Tests: `apps/api/test/statements.e2e.test.ts`.

- **Statements** (B7):
  - **Asking:** an officer on the incident, or the station, asks once a unit is on scene or after closing. The reporter is told; their report shows "asked for your statement".
  - **Recording:** they record (the voice note is kept) and type in their language, Auto, Yoruba, Hausa, Igbo, Pidgin or English. An English record is made by the translation adapter. The dev adapter returns a clearly marked machine draft and flags names, places and times.
  - **Signing:** they correct the English and sign with their PIN. The version is sealed with a SHA-256 seal and locked by a database trigger.
  - **Their copy:** download a PDF, save it for offline, share a view-only link for 7 days, or add more as a new version.
  - **Station view** (`/statements/:id` on the dashboard): the original, the English, AI confidence, the seal and an access log. Every open and download is logged. From there the station can request more detail (the reporter signs v2 and v1 stays) or a certified translator check (it shows in Admin → Help inbox).
- **False-alarm review** (decided 2026-10-21):
  - A report closed as a false alarm waits for the station head to confirm or overturn it (card on the incident page, `/me/station/false-alarms`).
  - After 48 hours it goes ahead on its own (jobs), and only then comes the warning or fine.
  - **Paid fines** go 40% to the agency, 30% to the rewards pool and 30% to the platform.
- **Donation fee:** the platform keeps 30%. The donate screen and the receipt show what reached the recipient.
- **Help replies:** Admin → Help inbox lists messages and translator checks. The reply shows in the person's Help and support with a notification.
- **Notification taps** now open fines, receipts, home, help, donate and statements.

## Home plans, install, Payment problem, live camera

Migration 020. Tests: `apps/api/test/billing.e2e.test.ts`.

- **Protect your home** (`/profile/home/plan`):
  - Pick Household, Household Plus or Community and pay the install fee plus the first month, by Paystack or the wallet (PIN). The home must be set first.
  - Payment creates an install job (`IN-` number).
  - Admin → Installation team books the visit, then marks it installed. That adds the plan's cameras and lights and starts billing (decided: billing starts at install).
- **Monthly billing** (jobs every 5 minutes):
  - Due plans are charged from the wallet when the owner turned on "Pay from my wallet first" and it has enough. Card renewal needs Paystack's saved card authorisation, which this build does not have, so a card renewal counts as a failed charge.
  - A failed charge starts dunning: days 1–7 everything works, days 8–14 live view and clips pause, days 15–30 feeds to responders pause, after day 30 devices go off. Report a problem and emergency reporting always work.
  - **Payment problem** (`/profile/home/billing`) offers Pay now, pay from the wallet (or top up the shortfall), Update card, and ask for a payment plan, which opens a help ticket.
  - Paying restores everything the same day.
  - `POST /dev/subscriptions/fail {userId, days}` simulates a failed charge on any day.
- **Live camera:**
  - `GET /me/devices/:id/live` checks the household member's permission and the plan stage, and logs every view to `camera_access_log`. The camera's Settings tab shows "Who viewed this camera".
  - A camera with `stream_url` plays the provider's stream. Development cameras have none, so the app shows a moving test pattern labelled "TEST FEED". No video provider is connected.
- **Money:** plan payments go to the platform fees wallet. No share of subscriptions goes to the rewards pool yet; that percentage has not been decided.

## Dashboards for station, agency and platform admin

Migration 021 (station settings, `station_broadcasts` for station messages). Tests: `apps/api/test/dashboards.e2e.test.ts`.

- **Station** (head and dispatchers):
  - **Live incidents:** stats (open and critical, median time to accept, officers on duty and free, rating), the priority queue, a live map of the zone, and the selected report with its brief, timeline, Reinforce, Assign, Transfer and Close.
  - **Incident detail:** reporter and place, brief, units on the report, merged reports, statement, timeline, notes, and the false-alarm review.
  - **Map:** reports, units, cameras and street lights with layer toggles, plus device alerts.
  - **Officers:** status, doing now, rating, accept time, rewards and latest comment. From here the head can assign a report (offer an escalated one, or send a second unit), message, and set on or off duty.
  - **Reports:** 7, 30 or 90 days by day, type and rating, recent closed reports, CSV export, and false alarms to confirm.
  - **Roster:** a week grid (click a cell to cycle Day, Night, Off, Leave), gaps against the minimum, shift rules, copy last week, and publish (officers are told).
  - **Messages:** to officers on duty, everyone, or one officer, with "needs reply" and urgent options, who has read and confirmed, and resend to unread. Messages are in-app only for now. Officers open them at `/officer/messages/:id`.
  - **Settings:** phone, opening hours, seconds to accept, minimum on duty, what happens if nobody accepts, alerts, and access counts.
- **Agency:** an Overview page with stats, live reports, station performance, the week and items needing attention, and a Stations page. Agency admins land on the Overview.
- **Platform admin:**
  - **Overview:** KPIs, 7 days of reports, device health, items needing attention, agency response, and money this month.
  - **Live incident map**, **Users** (role tabs and search), **Subscriptions** (change plan, reminder, pause or resume with a reason), and **KYC queue** (approve, ask for more, or reject with a reason).
  - Platform admins land on the Overview.
- **Maps:** schematic, not map tiles. Points are placed by their real distance from the centre.

## Location filter, street maps, agency map and Learn, duplicates, roster requests, message channels

Migration 022. Tests: `apps/api/test/dashboards.e2e.test.ts`.

- **Filter by location** (admin Overview, Users, Subscriptions, both live maps):
  - Five cascading lists, State → LGA → District → Area → Building, each loaded from the postcode service (`/places/levels/:level?parent=`), plus a postcode search and Clear.
  - The API takes `state`, `lga`, `district`, `area`, `building` and `postcode` (`core/location-filter.ts`). The deepest level chosen wins.
  - Each page filters by its own place: incidents by their building, devices and plans by their home, users by their home (or their station, for officers).
- **Street maps:** dashboard maps now use street tiles (Esri; set `NEXT_PUBLIC_TILES_MAP` to change provider), with zoom buttons and drag to pan, dimmed in dark mode. They fit the points until you move the map.
- **Live map by type:**
  - Emergencies and incidents, report tips and public issues, each in its own colour, can be toggled on and off.
  - The admin sees everything at `/admin/live`.
  - Each agency sees only what is routed to it, and only the kinds it handles, at `/agency/live`: emergencies always, tips and public issues when it handles them.
- **Agency Learn feed** (`/agency/learn`):
  - Agencies write videos, articles and quizzes in the topics that match their kind (police: crime prevention, scams, home security, child safety, drugs, rights; fire: fire safety, flood; health: first aid, outbreaks; and so on).
  - They send drafts for review, and only the platform team approves. Admins get a notification.
- **Duplicates** (station incident page):
  - "Possible duplicates" lists open reports within 500 m in the last hour that were not merged on their own.
  - **Merge** gives one response for everyone and tells the other reporters. **Keep separate** means the pair is never suggested again.
  - **Split** gives a joined report its own response.
- **Roster requests:**
  - Officers ask for a swap (their shift on one day for a teammate's on another) or for leave, from Duty and shifts.
  - The station head approves or declines with a reason in Roster. Approving updates the roster, and both officers are told.
- **Station messages by SMS and WhatsApp:** push is always on.
  - **WhatsApp** goes to staff who opted in (officer profile toggle).
  - **SMS** goes now, or to anyone who has not opened the message after N minutes (jobs).
  - **Urgent** messages text at once.
  - Each recipient shows WhatsApp, SMS or failed. The adapters are mocks with outboxes (`/dev/sms`, `/dev/whatsapp`) until providers are connected.

## Jurisdiction routing and the remaining admin pages

Migration 023. Tests: `apps/api/test/admin.e2e.test.ts`.

- **Routing by jurisdiction** (`IncidentsService.rankStations`). A new report goes to the first station of the right agency kind, in this order:
  1. A routing rule for the report's area, district or LGA (lowest priority number first), or the current station's named fallback.
  2. A station whose areas (`station_areas`: LGA, district or area) or drawn zone cover the report. A report without a building uses the nearest known building within 500 m.
  3. The nearest active station. The report gets an `outside_area` event so it is clear no station covers that place.
  - The officer is the nearest free, on-duty, verified officer at that station. Anyone who declined or let the offer expire is skipped.
  - If nobody there is free, it overflows the same way. The next station is chosen by the rule fallback, then another covering station, then the nearest.
  - Device tamper alerts use the same rule (`core/jurisdiction.ts`).
- **Station Settings → Area this station covers:** the station head adds or removes an LGA, district or area with cascading lists. Each change is logged. The demo Station 4 covers Ikeja GRA.
- **Coverage map** (`/admin/coverage`):
  - Device counts by status, plus "Not covered" (no station area includes the place).
  - Filters by type and status, on a map with each device's reach and the stations marked.
  - For a selected device: **Send technician** opens a repair ticket; **Alert nearest station** notifies the station that covers it.
- **Device wall** (`/admin/devices`):
  - Camera and light tiles by status, and a households table with **Schedule visit** (the owner is told the day and window).
  - The household modal shows camera and light side by side. A live view needs a reason, which is written to the camera access log (the owner sees it) and the audit log. Lights have **Turn on now** and **Flash test**.
- **Inventory** (`/admin/inventory`): stock by store, low stock, installed this month, in repair. **Add stock** and **Transfer stock** are logged, and you cannot move more than a store holds.
- **Agencies and stations** (`/admin/agencies`):
  - Agencies and stations by type, each station with the area it covers, and how many stations have no area.
  - The approval card (Approve / Ask for more / Decline) uses the agency lifecycle.
- **Audit log** (`/admin/audit`, entry `/admin/audit/:id`):
  - Filter by date range, person, action group and postcode. Export to CSV.
  - Every 403 for a signed-in person is logged as a refused attempt.
  - Each entry rechecks its link in the hash chain.
- **AI and LLM** (`/admin/ai`):
  - Use cases with model, mode, check rate and status. Model settings, language readiness, alerts, requests per day and cost.
  - Safety switches: pause all AI, pause translation (statements then wait for a person), or use the fallback model.
  - Statement translations below 80% confidence go to the review queue (`/admin/ai/reviews/:id`): Looks right, Add note, Send to translator, or Ask reporter to re-record. The signed version never changes.
- **CRM messaging** (`/admin/crm`, results `/admin/crm/:id`):
  - Audience by role, agency and place, with a size and cost estimate.
  - Push first, then SMS for people without the app or who have not read it after 10 minutes, then WhatsApp for people who opted in.
  - SMS is limited to 160 characters. Marketing goes only to people who have not opted out.
  - Quiet hours are 22:00 to 06:00 unless urgent. More than 500 people needs a second admin to approve.
  - Results show reach, reads, failures and why, the fallback, and cost. You can resend to the unreached or duplicate a campaign.
- **Donations** (Donations and payouts → Donations): gifts by the place of the receiving station, with amounts after the 30% fee. **Run payout** pays the queue.
- **Location filter** has been added to Fines, KYC queue, Installation team (installs and repairs) and Help inbox, and the subscription numbers now follow it too. The fines and help inbox tab parameter is now `status`, so it no longer clashes with the location `state`.

## Statements from anyone, agency pages, role-based access, help chat

Migrations 024 to 026. Tests: `apps/api/test/statements.e2e.test.ts`, `agency-rbac.e2e.test.ts`, `help.e2e.test.ts`.

- **Statements (traditional statement processing, digitised).**
  - The station, the agency, or an officer on a report can ask for a statement on any report (except cancelled or merged ones). It can come from the complainant, a victim, a witness, a suspect (a cautionary statement), or an officer. People can be picked from the report or added by phone; a new person is created and texted.
  - **On their phone:** the person writes it in their language and signs with their PIN. An officer's own statement works the same way (officer app: My statements, or Add statement on a report).
  - **In person:** the officer takes it down, reads it back, and the person confirms with a 6-digit code sent to their phone (15 minutes, 5 tries). A suspect is cautioned first (ACJA wording, time recorded) and must have someone present. The PDF shows the form's heading, who took it, who was present, and the caution.
  - Lists: Station → Statements, and Agency → Statements, each with a location filter.
- **Agency pages:**
  - **Officers:** ratings, rewards, invite by phone. Invited officers verify their identity before receiving reports.
  - **Inventory:** equipment by station, billed monthly. Shows status and checks.
  - **Routing rules:** rules by report type and area, which can be paused; defaults; "Test a postcode". Routing now skips paused rules.
  - **Billing:** fee schedule, invoices, pay balance, CSV.
  - **Assets:** traffic lights, street lights and cameras, with work orders and import. Remote actions need the safety plan signed and a second admin.
  - **Messaging:** the agency's staff, and citizens whose home is in its stations' areas.
  - **Settings:** profile (name and type changes wait for the platform), team by role, alerts, safety plan, access log.
  - **Station detail.**
- **Role-based access** (`PERMISSIONS` in `packages/domain/src/roles.ts`, `requirePerm` in the API, and sidebar filtering plus a "no access" page in the dashboard). New roles: platform finance, support and operations; agency finance and dispatcher are used.
  - Platform admins add or remove platform staff in Settings → Platform team.
  - Agency admins invite agency admin, finance, station head or dispatcher in Agency → Settings.
  - Demo sign-in has an account for each role.
- **Sign out** sits at the bottom of every dashboard sidebar. It also ends the session on the server.
- **Help chat:**
  - A floating Help button in the citizen and officer apps (above the tab bar) and on the dashboards.
  - The assistant answers questions about the platform, agencies, and anything else. When someone may be in danger, it points to SOS or 112 first.
  - It can hand the chat to a person. The person can also ask for a person themselves.
  - Help inbox → Live chats lets the help team take a chat, reply, add team-only notes, hand back to the assistant, or close it. A hand-off also opens a help ticket.
  - With `ANTHROPIC_API_KEY` set (or `ASSISTANT_PROVIDER=anthropic` with an `ant auth login` profile), the assistant is Claude Opus 5.5 (`adapters/assistant.ts`):
    - A cached system prompt with the platform guide (`help/knowledge.ts`).
    - Tools for agencies, Learn, the person's own reports and open items, plus web search and a hand-off tool.
    - `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) re-runs a policy decline on Anthropic's recommended model.
  - Without a key, and always in tests, an offline stand-in answers from the same guide and lookups. Usage appears under AI and LLM as "Help chat assistant".

## Page spacing and notification sounds

Migration 027. Tests: `apps/api/test/help.e2e.test.ts` (notification sounds).

- **Spacing:** page headers, cards and grids on the dashboards now have a bottom margin, so blocks never touch. Inside a grid, the grid's gap spaces them. A script checked every admin, agency and station page for blocks less than 6px apart and found none.
- **Notification sounds** (`packages/web-ui/src/sounds.ts`, `NotificationSounds.tsx`, `SoundSettings.tsx`):
  - Sounds are synthesised in the browser: siren, alarm, bell, chime, pulse, drum, soft pop, or silent. There are no audio files.
  - Each person picks one for each kind of notification: incoming reports and offers, safety alerts, updates on reports, and everything else. They also set volume and vibration.
  - Choices are saved to the account (`users.sounds`, `PATCH /me/preferences { sounds }`), so they follow the person to every device.
  - The citizen app, officer app and dashboards check `/me/notifications/new?after=` every 4 to 8 seconds, including in a background tab. When something new arrives they play the most urgent kind's sound and vibrate on phones.
  - Discreet mode silences everything.
  - Browsers allow sound only after the first tap on the page.
  - Station heads and dispatchers now get a "New report" dispatch notification when a report arrives at their station.
  - Settings live in Profile → Notification sounds (citizen), Profile → Notification sounds (officer), and Profile → Notification sounds (dashboard), each with a Play button to hear a sound.
- **Help assistant key:** the API's preview configuration (`.claude/launch.json`, outside the repository) has an empty `ANTHROPIC_API_KEY`. Put your key there and restart the API. While it is empty, the offline assistant is used.
