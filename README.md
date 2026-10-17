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
npm run dev:dashboard  # http://localhost:3000 → Sign in with a demo account
npm test               # all suites (the API suite resets the local database)
```

## Layout

| Path | What it is |
|---|---|
| `packages/tokens` | Design tokens → `tokens.css` (dark, light, system, reduced motion), `tokens.dart` for Flutter, `tokens.json`. Tests enforce WCAG AA on 21 colour pairs in both themes. |
| `packages/domain` | Pure TypeScript: state machines for incident, report delivery, subscription, withdrawal, tip, invite, technician job and fine; citizen tracking copy for every state; role‑filtered incident views; money rules. |
| `db/migrations` | Schema: identity, places, agencies, incidents, money, devices. The database itself enforces append‑only logs, a hash‑chained audit log, balanced ledger journals, and safety notifications that can't be switched off. |
| `apps/api` | NestJS: auth guard (staff need 2FA), incident lifecycle with timers, live SSE stream per role, fund‑wallet flow with signed webhooks, KYC, emergency contacts, places, deletion check. |
| `apps/dashboard` | Next.js: rail + top bar, theme switch saved to the account, My profile, live incident queue and detail. |

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
