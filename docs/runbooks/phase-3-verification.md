# Phase 3 Verification Runbook — Backstage Developer Portal

Run after `cdk deploy` (with `spec.developerPortal.enabled=true`) and after pushing
the Phase 3 render to `fleet-gitops`. All checks must pass.

> This runbook reflects the **actual** first bring-up, including six blockers that
> only surfaced at deploy time. They are all fixed in the committed code; the
> "Known issues fixed during bring-up" section at the bottom documents them so a
> future operator understands *why* the config looks the way it does. If you are
> adopting fresh, you should NOT hit them — but the symptoms are listed in case a
> chart/image version drifts.

---

## Prerequisites

Before `developerPortal.enabled=true`:

1. **Two Secrets Manager secrets** created (placeholders are fine pre-deploy; real
   values go in during steps 0a/0b):
   ```bash
   aws secretsmanager create-secret --region us-east-1 \
     --name fleet/backstage/github-token --secret-string PLACEHOLDER
   aws secretsmanager create-secret --region us-east-1 \
     --name fleet/backstage/oidc-client-secret --secret-string PLACEHOLDER
   ```
   Put their ARNs in `config/platform.yaml` under
   `spec.developerPortal.{githubTokenSecretArn,oidcClientSecretArn}`.

2. **An ACM certificate** for `spec.developerPortal.host` in the cluster region,
   status `ISSUED`. The AWS Load Balancer Controller auto-discovers it by domain
   name and attaches it to the HTTPS:443 listener — no annotation needed.
   ```bash
   aws acm list-certificates --region us-east-1 \
     --query "CertificateSummaryList[?DomainName=='<host>'].{Arn:CertificateArn,Status:Status}"
   ```
   Without a matching ISSUED cert, the ALB's 443 listener has nothing to terminate
   TLS with and the portal is unreachable.

3. **`developerPortal.host`** set to a hostname you can create DNS for (step 4).

---

## 0a. Set the GitHub PAT

Needed for catalog discovery (reads `catalog-info.yaml` from the repo) and the
scaffolder's `publish:github:pull-request` action. Scopes: `repo` + `pull_request`.
If your GitHub org enforces SAML SSO, authorize the PAT for the org.

```bash
aws secretsmanager put-secret-value --region us-east-1 \
  --secret-id fleet/backstage/github-token --secret-string 'ghp_...'
```

## 0b. Configure IdC OIDC + set the client secret

CDK creates the IdC customer-managed application; the OIDC client config + secret
are set in the console, then copied into Secrets Manager.

```bash
APP_ARN=$(aws cloudformation describe-stacks \
  --stack-name fleet-<name>-platform --region us-east-1 \
  --query "Stacks[0].Outputs[?OutputKey=='BackstageIdcApplicationArn'].OutputValue" \
  --output text)
echo "IdC app: $APP_ARN"
# Console: IAM Identity Center -> Applications -> fleet-<name>-backstage
#   -> set up the OIDC/SAML trust + redirect URI https://<host>/api/auth/oidc/handler/frame
#   -> copy the client secret
aws secretsmanager put-secret-value --region us-east-1 \
  --secret-id fleet/backstage/oidc-client-secret --secret-string '<client_secret>'
```

After setting either secret, restart so the CSI-synced env is re-read:
```bash
kubectl -n backstage rollout restart deploy/backstage
```
NOTE: until the OIDC client secret is real, `/api/auth/oidc/start` returns **404**
(the auth provider doesn't register) — that is expected, not a failure.

---

## 1. Argo Application + pods healthy

```bash
kubectl -n argocd get application backstage \
  -o jsonpath='{"sync="}{.status.sync.status}{" health="}{.status.health.status}{"\n"}'
kubectl -n backstage get pods
```

**Expected:** `Synced/Healthy`; `backstage-postgresql-0` `1/1 Running` and the
`backstage-*` backend pod `1/1 Running`. If the backend is `CrashLoopBackOff`,
read its logs — bring-up order of failures was techdocs → kubernetes → DB → up
(all fixed; see bottom section).

## 2. Pod Identity injection

```bash
kubectl -n backstage exec deploy/backstage -- env | grep AWS_CONTAINER_
```

**Expected:** `AWS_CONTAINER_CREDENTIALS_FULL_URI` + `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`
present. First pod after a fresh deploy may miss them (pod-identity-webhook cache
lag); `kubectl -n backstage rollout restart deploy/backstage` fixes it.

## 3. CSI-synced secret materialized

```bash
kubectl -n backstage get secret backstage-secrets -o jsonpath='{.data}' | jq 'keys'
```

**Expected:** `["AUTH_OIDC_CLIENT_SECRET","GITHUB_TOKEN"]`. Absent means the
SecretProviderClass didn't mount — see CSI failure modes in `phase-1-verification.md`.

## 4. ALB serving over HTTPS

The ALB Ingress Controller (installed in the bootstrap stack) fulfills the
`ingressClassName: alb` Ingress. The listener is **HTTPS:443 only** — there is no
port 80, so curl HTTP will time out; always test 443.

```bash
ALB=$(kubectl -n backstage get ingress backstage \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
echo "ALB: $ALB"

# ALB active + target healthy:
LBARN=$(aws elbv2 describe-load-balancers --region us-east-1 \
  --query "LoadBalancers[?DNSName=='$ALB'].LoadBalancerArn|[0]" --output text)
aws elbv2 describe-load-balancers --region us-east-1 --load-balancer-arns "$LBARN" \
  --query 'LoadBalancers[0].State.Code' --output text          # -> active
aws elbv2 describe-target-health --region us-east-1 \
  --target-group-arn $(aws elbv2 describe-target-groups --region us-east-1 \
    --load-balancer-arn "$LBARN" --query 'TargetGroups[0].TargetGroupArn' --output text) \
  --query 'TargetHealthDescriptions[].TargetHealth.State' --output text   # -> healthy

# Serve test (Host header lets you hit it before DNS exists):
curl -sS -k -o /dev/null -w "HTTPS -> %{http_code}\n" \
  -H "Host: <host>" "https://$ALB/"     # -> 200
```

**Expected:** ALB `active`, target `healthy`, `https://$ALB/` returns **200** and
the body title is `Scaffolded Backstage App`. The ALB has TWO security groups; the
*frontend* one opens 443 to 0.0.0.0/0 (the other is the shared backend SG and is
empty — that is normal).

## 5. DNS

```bash
# CNAME <host> -> the ALB hostname from step 4, at your DNS provider.
dig +short <host>            # should return the ALB / its A records
curl -sI https://<host>/ | head -1   # HTTP 200
```

## 6. Sign-in via IdC

Open `https://<host>/` in a browser → "Sign in" → redirects to AWS Identity Center
→ sign in as a member of `spec.identity.idc.adminGroupId` → land on the Backstage
home page.

## 7. Catalog ingestion

Browse to **Catalog**. Within ~100s (GitHub processor refresh) entities from
`projects/*/catalog-info.yaml` appear. With the smoke fixture
(`make render-gitops SMOKE=1`): Group/System/Component `smoke-team` + `hello`.

Debug: `kubectl -n backstage logs deploy/backstage | grep -i catalog` — look for
`permission denied` (PAT scopes) or `404` (wrong repo URL in values).

## 8. Scaffolder → PR → Argo

**Create…** → "Stateless service with bucket" → fill the form → submit. Two green
steps: `render` (fetch:template) and `pr` (publish:github:pull-request).

```bash
gh pr view <n>  --repo <org>/fleet-gitops
gh pr diff <n>  --repo <org>/fleet-gitops      # new projects/<proj>/deployments/<svc>.yaml
gh pr merge <n> --repo <org>/fleet-gitops --squash --delete-branch

kubectl -n argocd annotate applicationset fleet-workloads \
  argocd.argoproj.io/application-set-refresh=true --overwrite
kubectl -n <proj> get statelessservicewithbucket   # -> state ACTIVE
kubectl -n <proj> get bucket,role.iam.services.k8s.aws,podidentityassociation,deployment,svc,sa
```

---

## Known issues fixed during bring-up

These were hit on the first real deploy and are already fixed in the committed
config. Listed so the config choices make sense and so symptoms are recognizable
if a version drifts.

| Symptom | Root cause | Fix (committed) |
|---|---|---|
| `backstage-postgresql-0` `ImagePullBackOff` | Chart 2.6.0's postgresql subchart defaults to `bitnami/postgresql:15.4.0-debian-11-r10`, which Bitnami deleted from docker.io (moved free catalog to `bitnamilegacy/`, Aug 2025) | `values.yaml` pins `postgresql.image.repository: bitnamilegacy/postgresql` + `global.security.allowInsecureImages: true` |
| backend `Config must have required property 'techdocs'` | Stock app bundle validates a `techdocs` block even unused | Added `techdocs: {builder: local, generator.runIn: local, publisher.type: local}` |
| backend `Kubernetes configuration is missing` | Stock bundle initializes the kubernetes plugin and requires a `kubernetes` block | Added empty `kubernetes: {serviceLocatorMethod: multiTenant, clusterLocatorMethods: []}` |
| backend `password authentication failed for user "bn_backstage"` | Bitnami chart autogenerates a NEW random DB password on every Helm render; under Argo each sync rewrote the Secret while the initialized PVC kept the original password | `values.yaml` pins `postgresql.auth.password` so renders are deterministic. If you still see it: `kubectl -n backstage delete sts/backstage-postgresql pvc/data-backstage-postgresql-0 secret/backstage-postgresql`, let Argo recreate, then `rollout restart deploy/backstage` |
| Ingress has no `ADDRESS`; portal unreachable | No AWS Load Balancer Controller installed to fulfill `className: alb` | Controller installed in the bootstrap stack (Helm + dedicated IAM role + Pod Identity); see `lib/constructs/fleet-eks.ts` |
| `curl http://$ALB/` times out | Listener is HTTPS:443 only (no port 80) | Use `https://` — not a bug |
| EBS CSI controller `CrashLoopBackOff`, `no EC2 IMDS role found` (Phase 1, but in scope since Backstage needs PVCs) | Controller runs on the pod network, can't reach IMDS; node-role policy only helps the hostNetwork DaemonSet | EBS CSI add-on given its own Pod Identity association |

## If sign-in / scaffolder still fail

- **Redirect loop on sign-in** → the OIDC client secret in Secrets Manager doesn't
  match what IdC issued. Re-do step 0b; restart the pod.
- **"user not assigned to application"** → `aws sso-admin list-application-assignments
  --application-arn $APP_ARN` must list `adminGroupId`; the CDK creates this
  assignment, but confirm the group ID is correct.
- **Scaffolder PR step HTTP 403** → PAT lacks `repo`+`pull_request`, or org SAML SSO
  hasn't authorized the PAT.
- **`/api/auth/oidc/start` 404** → OIDC client secret still the placeholder; the auth
  provider didn't register. Set the real secret (step 0b) and restart.
- **Argo `OutOfSync`, "values file not found"** → the multi-source Helm Application's
  `$values` ref path is wrong; confirm two sources, one with `ref: values`.
