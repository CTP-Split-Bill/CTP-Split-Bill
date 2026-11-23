# The deploy workflow cannot reach Azure, or Azure is set up from scratch

**Use when:** setting up automatic deploys for the first time, rebuilding the
resource group, or the Deploy web workflow fails at Azure login or preflight.
**Last drilled:** never

## Before you start

- `az login` with **Owner** on resource group `ctp-split-bill` (Contributor
  cannot do step 5). Check: `az role assignment list --assignee "$(az ad signed-in-user show --query id -o tsv)" --all -o table`.
- **Admin** on the GitHub repo `CTP-Split-Bill/CTP-Split-Bill` (step 6).
- The app's environment is standard, not express. Check:
  `az rest --method get --url "https://management.azure.com$(az containerapp env show -n ctpsplitbill-env -g ctp-split-bill --query id -o tsv)?api-version=2025-10-02-preview" --query properties.environmentMode -o tsv`
  prints `WorkloadProfiles`. If it prints `Express`, step 2 fails: delete the
  environment (and its apps) and recreate it with an `az rest --method put`
  to the same URL, body `{"location":"northcentralus","properties":{"environmentMode":"WorkloadProfiles","workloadProfiles":[{"name":"Consumption","workloadProfileType":"Consumption"}]}}`.
  Plain `az containerapp env create` can produce an express one.
- Blast radius: step 2 changes how traffic routes; the live app keeps
  serving the same revision throughout.

## Steps

1. Set shell variables:
   ```bash
   APP=ctpsplitbill-web RG=ctp-split-bill
   REPO=CTP-Split-Bill/CTP-Split-Bill
   ```
2. Switch to multiple-revision mode and pin traffic to the serving revision:
   ```bash
   az containerapp revision set-mode -n $APP -g $RG --mode multiple
   CURRENT=$(az containerapp revision list -n $APP -g $RG --query "[?properties.trafficWeight==\`100\`].name | [0]" -o tsv)
   az containerapp ingress traffic set -n $APP -g $RG --revision-weight $CURRENT=100
   ```
3. Create the app registration the workflow logs in as:
   ```bash
   CLIENT_ID=$(az ad app create --display-name gh-deploy-ctpsplitbill --query appId -o tsv)
   az ad sp create --id $CLIENT_ID -o none
   PRINCIPAL_ID=$(az ad sp show --id $CLIENT_ID --query id -o tsv)
   echo "client=$CLIENT_ID principal=$PRINCIPAL_ID"   # both must print
   ```
4. Trust GitHub's `production` environment to log in as it:
   ```bash
   az ad app federated-credential create --id $CLIENT_ID --parameters "{\"name\":\"github-production\",\"issuer\":\"https://token.actions.githubusercontent.com\",\"subject\":\"repo:$REPO:environment:production\",\"audiences\":[\"api://AzureADTokenExchange\"]}"
   ```
5. Grant it Contributor on the resource group only (retry after 30 s if
   the principal is not found yet):
   ```bash
   az role assignment create --assignee-object-id $PRINCIPAL_ID \
     --assignee-principal-type ServicePrincipal --role Contributor \
     --scope "$(az group show -n $RG --query id -o tsv)"
   ```
6. Create the GitHub environment and its secrets:
   ```bash
   gh api -X PUT repos/$REPO/environments/production
   gh secret set AZURE_CLIENT_ID       -R $REPO --env production --body "$CLIENT_ID"
   gh secret set AZURE_TENANT_ID       -R $REPO --env production --body "$(az account show --query tenantId -o tsv)"
   gh secret set AZURE_SUBSCRIPTION_ID -R $REPO --env production --body "$(az account show --query id -o tsv)"
   ```
7. Add health probes: portal → `ctpsplitbill-web` → *Containers* → *Edit and
   deploy* → container → *Health probes*. Liveness and readiness: HTTP GET
   `/api/health`, port 3000. Save; this creates a revision at 0%. Promote it
   only after its FQDN's `/api/health` says `db:"ok"`.
8. Start the app if it is stopped:
   ```bash
   az containerapp show -n $APP -g $RG --query properties.runningStatus -o tsv
   ```
   If it says `Stopped`: portal → `ctpsplitbill-web` → *Overview* → **Start**.
   (`az containerapp start` exists only with `az extension add -n containerapp`.)
9. Run the first deploy of the tip of main:
   ```bash
   gh workflow run deploy-web.yml -R $REPO
   gh run watch -R $REPO "$(gh run list -R $REPO -w 'Deploy web' -L 1 --json databaseId -q '.[0].databaseId')"
   ```

## Verify it worked

```bash
az containerapp revision list -n $APP -g $RG \
  --query "[?properties.active].{name:name,traffic:properties.trafficWeight,image:properties.template.containers[0].image}" -o table
curl -s https://$(az containerapp show -n $APP -g $RG --query properties.configuration.ingress.fqdn -o tsv)/api/health
```

The newest revision has 100% traffic and an image ending in main's SHA
(`git rev-parse origin/main`); the curl prints `{"status":"ok","db":"ok"}`.

## If this didn't work

- `AADSTS70021` / no matching federated identity: the subject in step 4 must
  match exactly, including the environment name `production`.
- `AuthorizationFailed` in the workflow: step 5 did not apply, or it was
  scoped to the wrong resource group.
- Migration step cannot connect: confirm the `database-url` secret works from
  your own IP with `pnpm db:migrate` before re-running.
- Anything else: stop. Traffic has not moved unless the Promote step ran;
  confirm with the revision list above before changing anything by hand.

## Related

- Spec: `docs/specs/deploy.md`
