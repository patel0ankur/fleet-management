# Getting Started — Fleet Management Phase 1

Audience: a platform engineer who wants to stand up a Fleet control cluster in their own AWS account.

## What you'll have at the end

A running EKS control cluster in your shared-services account with:
- ArgoCD installed (HA), wired to your GitOps repo via an App-of-Apps Application
- kro + cert-manager + External Secrets Operator
- A configurable set of ACK controllers (default: ec2, iam, s3, rds, lambda, eks, sqs, sns)
- ECR repos for Fleet-managed images
- KMS-encrypted EKS secrets

What's **not** in Phase 1: Backstage, Fleet CRDs, DevOps Agent integration, cost reporting.

## Prereqs

- An AWS account you control — the **shared-services account**.
- AWS credentials with admin in that account, exported as `AWS_PROFILE` or env vars.
- **AWS Identity Center enabled** in the same account (the Argo CD capability requires it). `aws sso-admin list-instances` should return at least one ACTIVE instance.
- An IdC group (or user) that should get Argo CD ADMIN. Get its ID with:
  ```
  aws sso-admin list-instances
  aws identitystore list-groups --identity-store-id <IdentityStoreId>
  ```
- A GitHub repo to use as the **GitOps repo** (an empty new repo is fine).
- Local tools: `node >= 20`, `npm`, `aws`, `kubectl`, `helm`, `go >= 1.22`.

Run `./hack/check-tools.sh` (or `make tools-check`) to verify.

### One-time per account/region: CDK bootstrap

If this is a **fresh region** in the account (CFN stack `CDKToolkit` not present), run:

```bash
npx cdk bootstrap aws://<account-id>/<region>
```

`fleetctl deploy` runs this automatically; if you use `npx cdk deploy` directly, you must run it yourself first.

## Walkthrough

### 1. Clone and configure

```bash
git clone <this-repo>
cd fleet_infra
fleetctl init                         # copies the example, pre-fills your ARN
$EDITOR config/platform.yaml
```

(If `fleetctl` isn't built yet: `cp config/platform.example.yaml config/platform.yaml` and edit the placeholder ARN by hand.)

The fields you must edit:

| Field | What to put |
|---|---|
| `metadata.name` | DNS-safe name for this Fleet instance (e.g. `acme-fleet`) |
| `metadata.org` | Org slug (e.g. `acme`) — drives the future CRD group `platform.acme` |
| `spec.aws.sharedServicesAccount` | 12-digit AWS account id |
| `spec.aws.region` | A region with EKS + ACK availability |
| `spec.eks.adminPrincipalArns` | Your IAM role/user ARN. `fleetctl init` pre-fills the caller's identity. **Do not leave the example value.** Without this, `kubectl` returns 401 after deploy. |
| `spec.identity.idc.instanceArn` | From `aws sso-admin list-instances` |
| `spec.identity.idc.adminGroupId` | IdC group/user ID for Argo CD ADMIN |
| `spec.gitops.repoUrl` | Your GitOps repo URL |
| `spec.gitops.sshKeySecretArn` *or* `tokenSecretArn` | Secrets Manager ARN with the credential (only required for private repos) |

### 2. Build the CLI (optional but recommended)

```bash
make cli-build
sudo install cli/fleetctl/fleetctl /usr/local/bin/fleetctl
```

### 3. Validate config

```bash
fleetctl init
```

This re-runs tool checks and validates `config/platform.yaml` against the JSON schema.

### 4. Deploy

```bash
fleetctl deploy
```

Behind the scenes:
1. `cdk bootstrap` (idempotent) — provisions the CDK staging assets in the target account.
2. `cdk deploy --all`:
   - **`fleet-<name>-bootstrap`** — VPC, EKS, ECR, KMS (~20 min)
   - **`fleet-<name>-platform`** — cert-manager, ESO, kro, ACK, ArgoCD (~10 min)

### 5. Verify

```bash
fleetctl status
```

Then run through the [Phase 1 verification runbook](runbooks/phase-1-verification.md).

## Day-2

After Phase 1, **stop running CDK for routine changes**. The `fleet-bootstrap` Argo Application created by `PlatformStack` watches `<gitops.repoUrl>/<branch>/<pathPrefix>` recursively. Commit any new manifest under that path and Argo applies it within ~3 minutes.

Recommended seed for an empty GitOps repo:

```
clusters/control/
  00-projects/
    default.yaml          # AppProject describing what may be deployed where
```

CDK is only re-run for: EKS version bumps, new region/account, capability changes, or changes to the GitOps repo URL itself.

## Tearing down

```bash
fleetctl status                          # confirm the right cluster
make destroy CONFIG=config/platform.yaml # DANGEROUS — removes everything
```

KMS keys and ECR repos are retained by default to avoid losing artifacts. Delete them manually if you want a fully clean teardown.
