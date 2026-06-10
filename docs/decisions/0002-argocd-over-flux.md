# ADR 0002 — ArgoCD via EKS Capability (over Flux, over self-managed Helm)

**Status:** Accepted (2026-06-10)

## Context

The control cluster needs a GitOps engine that ArgoCD or Flux could provide. We need to choose one for Phase 1.

## Decision

**ArgoCD via the managed [EKS Argo CD Capability](https://docs.aws.amazon.com/eks/latest/userguide/create-argocd-capability.html).** The capability runs in the EKS control plane, not on our nodegroups; it ships a hosted UI, IAM Identity Center SSO, and the standard CRDs (`Application`, `ApplicationSet`, `AppProject`).

## Rationale

- **Capability is fully managed.** AWS handles patches, scaling, HA. No 7-pod ArgoCD HA install on our nodegroup, no admin bcrypt password to rotate, no Helm chart upgrade churn.
- **IdC SSO out of the box.** The capability requires AWS Identity Center auth; no local users. Matches the Phase 3 SSO target without a follow-up migration.
- **Hosted UI URL.** Returned as a CFN attribute (`Configuration.ArgoCd.ServerUrl`); no ingress, no cert-manager dependency.
- **Backstage plugin maturity.** The `argo-cd` plugin still works against the managed endpoint.
- **App-of-Apps pattern preserved.** Same `Application` CRD; same `directory.recurse` source.

## Consequences

- IdC must be enabled in the shared-services account (it is). Argo admin auth is now an IdC user/group, set via `spec.identity.idc.adminGroupId` in `platform.yaml`.
- We can't customize ArgoCD components (no Dex tweaks, no custom RBAC CSV) the way we could with the Helm install. The capability exposes only what AWS surfaces.
- Per-cluster singleton: only one ArgoCD capability per cluster. Fine for our design; if multi-tenant Argo per project becomes a need, revisit.
- Cost is hourly per-capability + per-managed-resource (see [pricing](https://aws.amazon.com/eks/pricing/)) — typically less than running an HA ArgoCD on `m6i.xlarge` 24×7.

## Alternatives considered

- **Self-managed ArgoCD via Helm** (the original Phase 1 design). Rejected once the EKS Capabilities feature became available — we'd be choosing to operate a control plane AWS already operates for us.
- **Flux** — mature, smaller footprint, but loses the Backstage integration story and isn't available as an EKS capability.
- **No GitOps in Phase 1; just CDK installs everything** — rejected per ADR 0001.
