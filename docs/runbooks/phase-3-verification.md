# Phase 3 Verification Runbook

Run after `fleetctl deploy` (with `spec.developerPortal.enabled=true`) and after pushing the Phase 3 render to `fleet-gitops`. All checks must pass.

## Prerequisites

Before deploy:

- GitHub PAT in Secrets Manager (`spec.developerPortal.githubTokenSecretArn`) with `repo` + `pull_request` scopes. SSO-authorize the PAT if your GitHub org enforces SAML SSO.
- An empty placeholder secret in Secrets Manager for the OIDC client secret (`spec.developerPortal.oidcClientSecretArn`). Real value is filled in step 0.

## 0. Wire IdC client secret (one-time)

After CDK creates the IdC application, the issuer URL + client_id are stable; only the client_secret needs to be pasted in.

```bash
APP_ARN=$(aws cloudformation describe-stacks \
  --stack-name fleet-<name>-platform \
  --region us-east-1 \
  --query "Stacks[0].Outputs[?OutputKey=='BackstageIdcApplicationArn'].OutputValue" \
  --output text)
echo "IdC app: $APP_ARN"

# Open the IdC console:
#   IAM Identity Center -> Applications -> $APP_ARN
#   -> Configure trusted token issuer + OIDC settings
#   -> Copy clientSecret
# Then:
aws secretsmanager put-secret-value \
  --region us-east-1 \
  --secret-id <oidcClientSecretArn> \
  --secret-string '<the client_secret from IdC>'
```

The Backstage pod re-reads its mounted secrets on rotation (configurable via Helm values `enableSecretRotation`); a pod restart is the safe default.

## 1. Backstage Application is Synced

```bash
kubectl -n argocd get application backstage \
  -o jsonpath='{"sync="}{.status.sync.status}{" health="}{.status.health.status}{"\n"}'
```

**Expected:** `sync=Synced health=Healthy` once the chart finishes installing (1-3 min).

## 2. Pods + Pod Identity injection

```bash
kubectl -n backstage get pods
kubectl -n backstage exec deploy/backstage -- env | grep AWS_CONTAINER_
```

**Expected:** Postgres pod + Backstage pod both `Running`. The Backstage pod has `AWS_CONTAINER_CREDENTIALS_FULL_URI` and `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`.

The first pod after a fresh deploy may not have these (pod-identity-webhook cache lag, see `phase-1-verification.md`). A `kubectl -n backstage rollout restart deploy/backstage` is the standard fix.

## 3. Synced K8s Secret materialized

```bash
kubectl -n backstage get secret backstage-secrets -o jsonpath='{.data}' | jq 'keys'
```

**Expected:** `["AUTH_OIDC_CLIENT_SECRET","GITHUB_TOKEN"]`. If absent, the SecretProviderClass mount didn't fire (see troubleshooting).

## 4. DNS + ALB reachable

```bash
HOST=$(grep '^\s*host:' config/platform.yaml | head -1 | awk '{print $2}')
dig +short $HOST
curl -sI https://$HOST/ | head -1
```

**Expected:** A record resolves to the ALB; `HTTP/2 200` (or 302 to `/sign-in`). If DNS is unset, point a CNAME at the ALB hostname surfaced by `kubectl -n backstage get ingress`.

## 5. Sign-in via IdC

Open `https://$HOST/` in a browser. Click "Sign in with OIDC". You should redirect to the AWS Identity Center login, sign in as a member of `spec.identity.idc.adminGroupId`, and land back on the Backstage home page.

## 6. Catalog ingestion

Browse to "Catalog". Within ~100s of first sign-in (the Backstage GitHub processor refresh interval), entities from `projects/*/catalog-info.yaml` appear. With the smoke fixture rendered (`make render-gitops SMOKE=1`):

- Group: `smoke-team`
- System: `smoke-team`
- Component: `hello`

If they don't appear: `kubectl -n backstage logs deploy/backstage | grep catalog` and look for `permission denied` (PAT scopes) or `404` (wrong repo URL in Helm values).

## 7. Scaffolder run end-to-end

Click "Create..." -> "Stateless service with bucket". Fill in:

- Project: `smoke-team` (EntityPicker)
- Service name: `goodbye`
- Image: leave default (nginx)
- Replicas: 1
- Container port: 8080

Submit. The task page should show two green steps:

1. `render` (fetch:template)
2. `pr` (publish:github:pull-request) - emits a URL to a PR in `fleet-gitops`

```bash
gh pr view <n> --repo <org>/fleet-gitops
gh pr diff <n> --repo <org>/fleet-gitops
```

**Expected:** new file `projects/smoke-team/deployments/goodbye.yaml` with apiVersion `kro.run/v1alpha1`, kind `StatelessServiceWithBucket`.

## 8. Merge + Argo reconciles

```bash
gh pr merge <n> --repo <org>/fleet-gitops --squash --delete-branch

# wait ~3 min for Argo refresh; or force a hard refresh:
kubectl -n argocd annotate applicationset fleet-workloads \
  argocd.argoproj.io/application-set-refresh=true --overwrite

kubectl -n argocd get applications | grep smoke-team
kubectl -n smoke-team get statelessservicewithbucket
kubectl -n smoke-team get bucket,role.iam.services.k8s.aws,podidentityassociation,deployment,svc,sa
```

**Expected:** kro instance `goodbye` reaches `state: ACTIVE`, ACK provisions the bucket/role/PIA, K8s creates the Deployment + Service.

## If any of these fail

- **Argo Application stuck in `OutOfSync` with "values file not found"** -> the Helm `$values` ref isn't pointing at the right path; `kubectl -n argocd get application backstage -o yaml | grep -A5 sources:` should show two sources, the second one with `ref: values` and the first one with `valueFiles: [$values/clusters/control/40-backstage/values.yaml]`.
- **CSI mount fails** -> apply the four CSI failure modes from `phase-1-verification.md` (they apply unchanged here): missing `usePodIdentity: "true"`, missing Pod Identity association, wrong namespace/SA, lacking `secretsmanager:GetSecretValue` on the secret ARN.
- **Backstage container CrashLoopBackOff with `database connection refused`** -> Postgres sub-chart still starting; wait. If persistent, `kubectl -n backstage get pvc` and confirm the volume bound.
- **Backstage redirect loop on sign-in** -> the `clientSecret` mounted at `/mnt/secrets/oidc-client-secret` doesn't match what IdC issued. Re-check step 0; rotate the Secrets Manager value; restart the pod.
- **Sign-in fails with "user not assigned to application"** -> the IdC group assignment didn't take. Confirm `aws sso-admin list-application-assignments --application-arn $APP_ARN` lists `adminGroupId`.
- **Scaffolder PR step fails with HTTP 403** -> GitHub PAT lacks `repo` + `pull_request` scopes, OR the org enforces SAML SSO and the PAT was never authorized. Re-issue the PAT and click "Configure SSO" on the token in GitHub settings.
- **Scaffolder PR step fails with "invalid template ref"** -> the Template entity didn't load. `kubectl -n backstage exec deploy/backstage -- curl -s localhost:7007/api/catalog/entities?filter=kind=template | jq '.[].metadata.name'` should list `stateless-service-with-bucket`. If absent, `catalog.locations` glob in `values.yaml` is wrong or the GitHub PAT can't read the repo.
- **Catalog entries don't appear after merge** -> wait one full refresh interval (~100s), then `kubectl -n backstage logs deploy/backstage | grep -i 'catalog\|process' | tail -50`.
