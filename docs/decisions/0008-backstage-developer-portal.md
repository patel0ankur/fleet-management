# ADR 0008 - Backstage as the Fleet developer portal

**Status:** Accepted (2026-06-10)

## Context

Phases 1+2 left a working but operator-grade developer experience: ship a workload by hand-editing `projects/<name>/deployments/<name>.yaml` in the GitOps repo and pushing. That's fine for the platform team; it's not fine for application developers. Phase 3 needs a self-service surface.

The reference architecture (OpenChoreo) ships a custom Backstage build with 20+ in-house plugins, an API-polled catalog provider, and scaffolder actions that POST CRs through their control-plane API server. Fleet has no API server - the GitOps repo *is* the API. So OpenChoreo's pattern is the eventual destination, but Phase 3 has to be reachable in days, not weeks.

## Decision

**Install stock upstream Backstage in-cluster, sign in via the same IdC instance Argo uses, scaffold workloads via Backstage's built-in `publish:github:pull-request` action, and source the catalog from `catalog-info.yaml` files in the GitOps repo.**

Six concrete choices:

1. **Stock upstream Helm chart, no custom image (yet).** No org-baked container, no plugin install at deploy time. Anything that requires `app-config.yaml` plugin wiring (`kubernetes-ingestor`, TechDocs builder, an OpenChoreo-style catalog provider that reads Project/Deployment CRs) is deferred to Phase 3.5 once we have a CI/CD pipeline producing our own image.
2. **IdC OIDC, reusing the Argo IdC instance.** One IdP for the whole platform; no second login surface. Cost: a second IdC customer-managed application (the ARGOCD capability creates its own; Backstage's is provisioned by `AwsCustomResource` calls to `sso-admin:CreateApplication` + `CreateApplicationAssignment` in `02-platform-stack.ts`).
3. **`catalog-info.yaml` in `fleet-gitops` is the catalog source-of-truth.** Each project commits a `catalog-info.yaml` next to its manifests; Backstage's catalog discovery walks `projects/*/catalog-info.yaml` via GitHub URL targets. Phase 3.5 augments (not replaces) this with a custom catalog provider plugin reading Project/Deployment CRs from the cluster.
4. **Scaffolder writes via GitHub PR**, not direct push to `main`. Reviewable, auditable, identical to the human GitOps workflow. Cost: ~30s-2min latency between scaffolder click and Argo sync (PR review + merge + Argo poll); we accept it.
5. **Postgres sub-chart, not RDS.** Dev-grade now; Phase 7 hardens to an ACK `DBInstance` + ASCP-mounted password.
6. **Per-project AppProject deferred** to Phase 3.5. Today everything still uses the `default` AppProject (the Phase 1 one). Once Backstage onboarding is producing real tenants we add an ApplicationSet that materializes one AppProject per Project CR.

## Rationale

- **Stock chart unblocks the demo.** The upstream chart ships OIDC, GitHub PR scaffolding, and URL-based catalog discovery out of the box - exactly what Phase 3's user story needs. Custom-image work is real (TypeScript build, ECR push, a CI pipeline we don't have) and would block Phase 3 indefinitely.
- **PR-based scaffolding inherits Phase 2's review surface.** Anything Backstage emits is a normal GitHub PR with a normal CODEOWNERS path. No new review tooling.
- **`catalog-info.yaml` is idiomatic Backstage.** It works without any custom plugins, keeps Backstage entities next to the resources they describe, and survives Backstage going down (the source-of-truth is Git).
- **One IdP cuts operational variance.** Adding a second OIDC application in the same IdC instance is cheap; running a second IdP is not.
- **No new CDK stack.** Phase 3's bootstrap surface is small (one IAM role, one Pod Identity association, one IdC application), comfortably extending `02-platform-stack.ts` without new cross-stack references.

## Consequences

- **Two manual steps per Fleet adopter on first deploy:** create the GitHub PAT in Secrets Manager, and after the IdC application is created, paste its `client_id`/`client_secret` from the IdC console into the OIDC client-secret in Secrets Manager. Both ARNs are validated in `platform.yaml`. CDK provisions only what only CDK can.
- **Catalog discovery latency.** Default refresh interval is ~100s; new Projects don't show up instantly.
- **Stock-chart guardrails:** any feature requiring a backend plugin (kubernetes-ingestor, TechDocs, custom Fleet catalog provider) goes in Phase 3.5.
- **PR auth boundary:** the GitHub PAT scopes determine what the scaffolder can do. We require `repo` + `pull_request`; if the org enforces SAML SSO, the PAT must be SSO-authorized.
- **DNS is operator-managed.** Phase 3.5 adds an ACK `Route53.RecordSet` for the Backstage `host`.

## Bring-up reality (what "stock chart" actually required)

The "stock chart, config-only" decision held, but first bring-up showed "config-only"
is more than the plan implied. Captured here so the values/CDK choices are legible
and the next phase budgets correctly (full detail + symptoms in
`docs/runbooks/phase-3-verification.md`):

- **The stock app bundle validates config for plugins it ships even when unused.**
  The backend refused to start without `techdocs` and `kubernetes` blocks present.
  We provide minimal stubs (`techdocs: local`, empty `kubernetes` locator). Real
  TechDocs and cluster-view wiring are still Phase 3.5.
- **The bundled Bitnami postgres is fragile in two ways:** (1) its default image tag
  was deleted from docker.io (pinned to `bitnamilegacy`), and (2) the chart
  regenerates the DB password on every Helm render, which fights Argo's repeated
  syncs against an already-initialized PVC (pinned an explicit password). Both
  reinforce the Phase 7 plan to move to RDS — the in-cluster DB is the least robust
  part of the stack.
- **Ingress needs the AWS Load Balancer Controller, which is not a managed add-on.**
  We install it in the bootstrap stack (Helm + IAM role + Pod Identity), mirroring
  the EBS CSI controller. The ALB serves HTTPS-only and auto-discovers the ACM cert
  by hostname; the operator pre-creates the cert and the DNS CNAME.

## Alternatives considered

- **Custom Backstage image from day 1 (the OpenChoreo path).** Rejected for Phase 3; revisit in 3.5. Rationale above.
- **Direct push to `main` from the scaffolder.** Lower latency, but loses the human review gate that Phase 2 explicitly designed for. Rejected.
- **Self-hosted IdP (Keycloak/Dex).** Adds a second auth surface to operate. Rejected; reuse IdC.
- **External RDS for Backstage Postgres in Phase 3.** Adds an ACK CR (RDS), a peering or PrivateLink path, and a real backup story. Defer to Phase 7's general database hardening.
- **Per-project AppProjects in Phase 3.** Useful but orthogonal to the developer UX win this phase chases; doing it well requires designing the per-project sourceRepo + destination + RBAC contracts. Defer.

## Future (Phase 3.5+)

- **Custom Backstage image** with `kubernetes-ingestor` for auto-derived catalog entries from Project/Deployment CRs.
- **Custom Fleet catalog provider plugin** (the OpenChoreo `OpenChoreoEntityProvider` shape).
- **Per-project AppProjects** via a new ApplicationSet under `clusters/control/40-projects/`; updates to `templates/applicationsets/projects.yaml` to use `project: '{{path[1]}}'`.
- **TechDocs.**
- **Cost-Insights plugin** wired to `spec.cost.curBucket`.
- **Route53 ACK RecordSet** for `spec.developerPortal.host`.
- **Phase 4** introduces a Fleet operator that converts `Deployment` CR -> kro instance; the scaffolder PR becomes one CR instead of two.
