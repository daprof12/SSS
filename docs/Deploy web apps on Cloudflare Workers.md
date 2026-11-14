# Deploy the web apps on Cloudflare Workers

The citizen/officer app (`apps/mobile`, with the landing page) and the staff dashboard (`apps/dashboard`) run on Cloudflare Workers, built with the OpenNext adapter. The API (`apps/api`) and PostgreSQL do not run on Workers: host them on a container host and point the web apps at the API.

## Why `npx wrangler deploy` fails at the repo root

The repo is an npm workspace with several apps. Wrangler run at the root cannot tell which one to deploy ("application detection logic has been run in the root of a workspace"). Each app is its own Worker with its own `wrangler.jsonc`, deployed with the commands below.

## Cloudflare setup: two Workers, one repo

Create two Workers in Cloudflare (Workers & Pages → Create → Import a repository), both connected to this repository. Leave **Root directory** as `/` for both.

| Setting | Citizen app (`sss-app`) | Dashboard (`sss-dashboard`) |
|---|---|---|
| Build command | `npm run cf:build:mobile` | `npm run cf:build:dashboard` |
| Deploy command | `npm run cf:deploy:mobile` | `npm run cf:deploy:dashboard` |

Turn off builds for non-production branches for now: there is no separate preview Worker, so a branch build would deploy over the live one.

The Worker name in Cloudflare must match `name` in the app's `wrangler.jsonc` (`sss-app`, `sss-dashboard`), or change the file to match.

### Addresses

| What | Address |
|---|---|
| Citizen and officer app, landing page | `https://sssng.online` (and `www.sssng.online`) |
| Staff dashboard | `https://dashboard.sssng.online` |
| API | `https://api.sssng.online` |

The web apps get the API and dashboard addresses at build time from `apps/mobile/.env.production` and `apps/dashboard/.env.production`, which are committed (they are not secrets). No build variables need to be set in Cloudflare. A variable set in the build environment overrides the file, for example to build a staging copy against another API:

| Variable | Used by | Default in `.env.production` |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | both apps | `https://api.sssng.online` |
| `NEXT_PUBLIC_DASHBOARD_URL` | citizen app (landing page "Staff sign in") | `https://dashboard.sssng.online` |
| `NEXT_PUBLIC_SMS_NUMBER`, `NEXT_PUBLIC_TILES_MAP`, `NEXT_PUBLIC_TILES_SATELLITE` | optional overrides | – |

The build image needs Node 22.12 or newer (Wrangler 4). Cloudflare's default image already has it.

### Connect sssng.online

The domain's nameservers currently point at the registrar's parking service (`dns-parking.com`), not Cloudflare. Until that changes the Workers are only reachable on their `*.workers.dev` addresses, and the app's calls to `api.sssng.online` fail.

1. In Cloudflare, add `sssng.online` as a site (free plan is enough) and note the two nameservers it gives you.
2. At the registrar, replace the nameservers with Cloudflare's. Wait until Cloudflare shows the site as **Active**.
3. In `apps/mobile/wrangler.jsonc` and `apps/dashboard/wrangler.jsonc`, uncomment the `routes` block and push. The next deploy attaches `sssng.online`, `www.sssng.online` and `dashboard.sssng.online` and creates their DNS records and certificates. Doing this before step 2 finishes makes the deploy fail.
4. Add a DNS record for `api` pointing at wherever the API is hosted.

## The API side

- Host `apps/api` and PostgreSQL 16 with PostGIS on a container host (Render, Railway, Fly, or the Kubernetes setup in `deploy/` on the `devops-setup` branch), reachable at `https://api.sssng.online`.
- Set these on the API:

  ```
  NODE_ENV=production
  PUBLIC_BASE_URL=https://api.sssng.online
  APP_URL=https://sssng.online
  DASHBOARD_URL=https://dashboard.sssng.online
  CORS_ORIGINS=https://sssng.online,https://www.sssng.online,https://dashboard.sssng.online
  ```

  In production the API accepts no origins other than `CORS_ORIGINS`. Add the two `*.workers.dev` addresses to it if you want to test there before the domain is connected. `APP_URL` and `DASHBOARD_URL` are where Paystack sends people back after paying.
- Run the migrations (`npm run db:migrate`) against the production database before the first sign-in.

## Local check

Needs Node 22.12+.

```bash
NEXT_PUBLIC_API_URL=http://localhost:4001 NEXT_PUBLIC_DASHBOARD_URL=http://localhost:3000 npm run cf:build:mobile   # without these it builds against sssng.online
npm run cf:preview -w @erp/mobile        # serves the built Worker on http://localhost:8787
```

`npm run cf:deploy:mobile` deploys from your machine after `npx wrangler login`.

## What is configured

- `apps/*/wrangler.jsonc`: Worker name, `nodejs_compat`, static assets from `.open-next/assets`.
- `apps/*/open-next.config.ts`: default OpenNext config. The pages are static shells that call the API from the browser, so there is no R2 cache or image binding.
- Each Worker is about 1.3 MB compressed, inside the 3 MB limit of the free plan.
