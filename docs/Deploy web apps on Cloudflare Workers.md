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

### Build variables (Settings → Build → Variables and secrets)

These are compiled into the browser bundle, so they are **build** variables, not runtime ones. Changing one needs a new build.

| Variable | Citizen app | Dashboard | Value |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | required | required | Public URL of the API, e.g. `https://api.example.com`. Without it the apps call `http://localhost:4000`. |
| `NEXT_PUBLIC_DASHBOARD_URL` | required | – | Public URL of the dashboard Worker. The landing page's "Staff sign in" goes to `<this>/sign-in`. |
| `NEXT_PUBLIC_SMS_NUMBER`, `NEXT_PUBLIC_TILES_MAP`, `NEXT_PUBLIC_TILES_SATELLITE` | optional | optional | Only to override the defaults. |

The build image needs Node 22.12 or newer (Wrangler 4). Cloudflare's default image already has it.

## The API side

- Host `apps/api` and PostgreSQL 16 with PostGIS on a container host (Render, Railway, Fly, or the Kubernetes setup in `deploy/` on the `devops-setup` branch).
- Set `CORS_ORIGINS` on the API to the two Worker URLs, comma-separated, e.g. `https://sss-app.<account>.workers.dev,https://sss-dashboard.<account>.workers.dev` (or your custom domains). In production the API accepts no other origins.
- Run the migrations (`npm run db:migrate`) against the production database before the first sign-in.

## Local check

Needs Node 22.12+.

```bash
NEXT_PUBLIC_API_URL=http://localhost:4001 npm run cf:build:mobile
npm run cf:preview -w @erp/mobile        # serves the built Worker on http://localhost:8787
```

`npm run cf:deploy:mobile` deploys from your machine after `npx wrangler login`.

## What is configured

- `apps/*/wrangler.jsonc`: Worker name, `nodejs_compat`, static assets from `.open-next/assets`.
- `apps/*/open-next.config.ts`: default OpenNext config. The pages are static shells that call the API from the browser, so there is no R2 cache or image binding.
- Each Worker is about 1.3 MB compressed, inside the 3 MB limit of the free plan.
