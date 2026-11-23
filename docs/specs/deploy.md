---
type: infrastructure
---
# Deploy — merges to main ship themselves

## Purpose

Shipping is a merge, not a ritual performed by someone who remembers the
steps. Every merge to main reaches the live URL through the same health-gated
path, and a revision that cannot reach its database never takes traffic.

## The pipeline

```
merge to main
  → CI (.github/workflows/ci.yml)                       typecheck, test, build
  → Publish (.github/workflows/publish-web-image.yml)   image → ghcr.io/<owner>/ctp-split-bill-web:<sha>
  → Deploy (.github/workflows/deploy-web.yml)
      1. preflight     app is running and in Multiple revision mode
      2. migrate       pnpm db:migrate against the production database
      3. revision      new revision <app>--r<run>-<sha7>, created at 0% traffic
      4. smoke         GET https://<revision-fqdn>/api/health says db:"ok"
      5. promote       new revision 100%, previous revision 0% (kept active)
```

- CI is the **only** place images are built. Contributor laptops never need
  docker. Each image is tagged with the commit SHA it was built from.
- Deploy authenticates to Azure with GitHub OIDC (federated credential on
  an Entra ID app registration). No Azure password is stored in GitHub.
- Migrations read `DATABASE_URL` from the Container App's own secret; there
  is one copy of the connection string. The workflow opens a firewall rule
  for the runner's IP and removes it whether or not the migration succeeds.
- The smoke test hits the new revision's own FQDN, not the public URL, and
  retries for about three minutes to absorb a scale-from-zero cold start.
- The previous revision stays active at 0% so rollback is a traffic shift,
  not a rebuild. Revisions older than that are deactivated on promote.
- `workflow_dispatch` with an `image_tag` redeploys any published SHA.
- Deploys never overlap: one runs at a time, later ones queue.

## Configuration

- Secrets live in Container Apps settings; `.env.example` documents every
  variable. Probes point at `/api/health`.
- `PG_POOL_MAX=1` — connection etiquette on a B1ms server.
- GitHub environment `production` holds `AZURE_CLIENT_ID`,
  `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`. App, resource group, database
  server and image names are set at the top of the deploy workflow.
- One-time setup (revision mode, identity, role, probes):
  `docs/runbooks/deploy-setup.md`.

## Error states

| Failure | What happens |
|---|---|
| image build fails | CI red; nothing publishes or deploys |
| app is stopped, or in Single revision mode | preflight fails with the fix in the error; nothing changes |
| migration fails | deploy stops before a revision is created; firewall rule removed; old revision keeps traffic |
| new revision never says `db:"ok"` | smoke fails; new revision is deactivated; old revision keeps traffic |
| bad code that still passes `/api/health` | it ships; roll back by shifting traffic to the previous revision |

## Constraints & decisions

- GHCR, not ACR — free for public repos; the package is public, so the app
  pulls without registry credentials.
- Container Apps consumption, min replicas 0 (scale-to-zero is the default
  posture); anything needing always-on gets its own discussion.
- The environment is standard (`environmentMode: WorkloadProfiles`, the
  Consumption profile), never express: express allows one active revision,
  so the 0%-then-promote gate cannot run there. `az containerapp env create`
  and the portal can produce an express environment without asking.
- The deploy identity is an app registration, not a user-assigned managed
  identity: the subscription does not register `Microsoft.ManagedIdentity`,
  and registering a provider needs subscription-level rights the resource
  group's owner lacks.
- Migrations run before the new revision takes traffic, so the revision
  still serving must work against the migrated schema. Migrations add; a
  rename or drop ships as add → deploy → remove in a later migration.
- The smoke test checks only `/api/health`. Sign-in, isolation and the core
  flow are the production smoke-test runbook's job, after deploy.
- The worker deploys separately (as a Functions timer when precomputation
  arrives — an epic ticket, not part of the base deploy).

## Verify

- The broken-revision drill: create a revision at 0% with a bad database
  URL (`az containerapp update --revision-suffix drill --set-env-vars
  DATABASE_URL=postgresql://nobody:wrong@localhost/x`); its FQDN's
  `/api/health` returns 503 while the public URL stays 200. Deactivate it,
  then restore the template with `--set-env-vars
  DATABASE_URL=secretref:database-url` — the next deploy copies the app's
  current template, bad variable included.
- A one-line PR reaches the live URL in < 10 minutes, untouched by hands:
  after merge, `az containerapp show --query properties.template.containers[0].image`
  ends in the merge commit's SHA.

## Key ADRs

None yet. A change to registry, hosting or the gate gets one.
