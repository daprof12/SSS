# Deploying SSS

How the platform runs in production: containers on Kubernetes, Cloudflare in front, GitHub Actions for build, security checks and release.

```
 users ──► Cloudflare (CDN, TLS, DDoS, firewall, rate limits)
              │
              ▼
        cloud load balancer ──► ingress-nginx (load balancing, TLS, rate limits)
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
        sss-mobile (2–10)   sss-dashboard (2–10)    sss-api (3–20)
        app.<domain>        dashboard.<domain>      api.<domain>
                                                        │
                                                        ▼
                                     managed PostgreSQL 16 + PostGIS
                                     (primary + standby, daily backups, PITR)
```

## What is in this folder

| Path | What it is |
|---|---|
| `docker/api.Dockerfile` | API image (also runs migrations). Multi-stage, non-root, production dependencies only. |
| `docker/web.Dockerfile` | Dashboard and app images (`--build-arg APP=dashboard|mobile`). Next.js standalone output. |
| `k8s/base` | Deployments, Services, autoscalers, disruption budgets, ingress, network policies, namespace. |
| `k8s/overlays/staging`, `k8s/overlays/production` | Per-environment hostnames, sizes and image tags. |
| `k8s/jobs/migrate.yaml` | Database migration job, run before each rollout. |
| `k8s/components/vpa` | Vertical Pod Autoscaler in advice mode (optional). |
| `cloudflare/main.tf` | Terraform: DNS, TLS settings, cache rules, firewall, rate limits. |
| `compose/` | The whole stack behind an Nginx load balancer on one machine, for rehearsals and load tests. |
| `../.github/workflows` | `ci` (typecheck, tests, builds, config validation), `security` (CodeQL, dependency audit, secret scan, config scan), `release` + `deploy` (signed images → staging → approval → production). |

## Scaling

**Horizontal (more instances).** Each app has a HorizontalPodAutoscaler.

| App | Min | Max | Scales on |
|---|---|---|---|
| `sss-api` | 3 | 20 | CPU 65 %, memory 80 %. Doubles within 30 s on a surge; shrinks slowly (5 min window). |
| `sss-dashboard`, `sss-mobile` | 2 | 10 | CPU 70 % |

Pods spread across zones and nodes, and a disruption budget keeps at least 2 API pods up during node maintenance. Add the cluster autoscaler (or Karpenter) so the cluster adds nodes when pods do not fit.

The API is safe to run as many instances:
- Live incident streams work on any instance. An event raised on one instance reaches the others through PostgreSQL `LISTEN/NOTIFY` (`apps/api/src/core/bus.ts`).
- Background jobs (billing, push delivery, overdue sweeps) claim rows with `for update skip locked`, so two instances never do the same work.
- Uploaded media is stored in the database, not on a pod's disk.

**Vertical (bigger instances).**
- Apps: change `resources` in `k8s/overlays/production/patch.yaml` and merge; the rollout has no downtime. Turn on `components/vpa` to get sizing advice from real usage (`kubectl -n sss describe vpa sss-api`).
- Database: resize the managed instance (CPU, memory, storage) from the provider's console; with a standby this is a short failover. This is the main vertical lever, because the database is the one part that does not scale out for writes.

**Database connections.** Each API pod opens up to `DB_POOL_MAX` (10) connections plus 3 for the event bus. At 20 pods that is about 260. Size the database's `max_connections` for it, or put PgBouncer in front in *session* mode (transaction mode breaks `LISTEN`).

## CDN and load balancing

- **CDN (Cloudflare).** Hashed build assets under `/_next/static/` are cached at the edge for a year. The API and the service worker (`/sw.js`) are never cached. HTTP/3 and Brotli are on.
- **Load balancing.** Cloudflare → the cloud provider's load balancer → ingress-nginx → pods. The ingress balances by latency (EWMA), sends traffic only to pods that pass the readiness check (`GET /health`, which checks the database), and keeps live streams open for up to an hour without buffering.
- **Zero-downtime releases.** Rolling update with `maxUnavailable: 0`; a pod keeps serving for 10 s after it is told to stop, while the load balancer drains it.

## Security

| Layer | Control |
|---|---|
| Edge | Cloudflare DDoS protection, managed + OWASP firewall rules, bot challenge on the staff dashboard, rate limits (sign-in 10/min, API 300/min per address), `/dev` blocked. |
| Transport | TLS 1.2+ everywhere, strict mode to the origin, HSTS with preload, certificates renewed by cert-manager. |
| Ingress | Second rate limit per address, 12 MB body limit. |
| Network | Default-deny network policies. Only the ingress reaches the apps; only the API reaches the database and outside providers; web pods have no outbound access. |
| Pods | Pod Security "restricted": non-root, read-only filesystem, all capabilities dropped, seccomp, no Kubernetes API token. |
| Secrets | Never in git or images. Kept in a secret manager and synced to the `sss-api-secrets` Secret (see `k8s/base/secrets.example.yaml`). The API refuses to start in production without real keys, and refuses `DEV_TOOLS=1`. |
| Supply chain | Every image is scanned (Trivy), carries an SBOM and build provenance, and is signed (cosign). Dependabot opens weekly update PRs. CodeQL and gitleaks run on every PR. |
| Access | Production deploys need an approval in GitHub. The pipeline's cluster account should be limited to its namespace. Turn on branch protection for `main` (required checks: CI, Security). |
| Data | Managed PostgreSQL with encryption at rest, TLS (`sslmode=require`), daily backups and point-in-time recovery; test a restore every quarter. |

## First-time setup

1. **Cluster.** Kubernetes 1.28+ in at least two zones, with a network plugin that enforces NetworkPolicy (Cilium or Calico), metrics-server, [ingress-nginx](https://kubernetes.github.io/ingress-nginx/) and [cert-manager](https://cert-manager.io/) with a `ClusterIssuer` named `letsencrypt`.
2. **Database.** A managed PostgreSQL 16 with the PostGIS extension, a standby in a second zone, and private networking to the cluster. Narrow the `api-egress` network policy to its address.
3. **Hostnames.** Replace `example.com` in `k8s/overlays/*/kustomization.yaml` and `patch.yaml`.
4. **Secrets.** Create `sss-api-secrets` in each namespace from `k8s/base/secrets.example.yaml`.
5. **Cloudflare.** `cd deploy/cloudflare && terraform init && terraform apply -var zone_id=… -var domain=… -var origin_ip=<load balancer IP>`.
6. **GitHub.** Create environments `staging` and `production` (add required reviewers to production). In each: secret `KUBE_CONFIG`; variables `API_URL` and `NAMESPACE` (`sss-staging` / `sss`). Optional variables: `SMS_NUMBER`, `TILES_MAP`, `TILES_SATELLITE`.
7. **Release.** Merge to `main`. The pipeline builds, scans and signs the images, migrates and deploys staging, then waits for approval before production.

## Day to day

```bash
kubectl -n sss get pods,hpa                      # what is running, how far it has scaled
kubectl -n sss logs deploy/sss-api -f            # API logs
kubectl -n sss rollout undo deploy/sss-api       # roll back the last release
kubectl -n sss scale deploy/sss-api --replicas=8 # manual scale (the autoscaler takes over again)
```

Migrations must stay compatible with the version already running: add columns first, remove them a release later. A failed migration stops the release before any pod changes.

## Rehearse on one machine

```bash
docker compose -f deploy/compose/docker-compose.yml up --build -d
```

App on :8080, dashboard on :8081, API on :8082, three API instances behind Nginx. Scale with `--scale api=5`.

## Still to do before real traffic

- **Monitoring and alerts.** Install a metrics and logs stack (for example kube-prometheus-stack and Loki, or the cloud's own) and alert on 5xx rate, latency, pod restarts, database connections and certificate expiry. The API does not expose Prometheus metrics yet.
- **Live-stream token.** The incident stream takes the access token in the URL (see the main README). Replace it with a short-lived stream ticket so tokens do not appear in proxy logs.
- **Dependency upgrades.** Two high-severity advisories need major upgrades: Next 16 (postcss) and zod 4. The audit gate blocks on critical until those land.
- **Media storage.** Uploads live in PostgreSQL. Move them to object storage (S3-compatible) behind the CDN when volume grows.
- **Mock providers.** NIPOST postcodes and KYC are still mocked (main README).
- **Pin actions by commit.** Workflows pin actions by version tag; pin by commit SHA for stricter supply-chain control.
