# ADR 0005 — Use EKS Capabilities (managed) over self-managed Helm

**Status:** Accepted (2026-06-10), supersedes the Helm-driven sections of the original Phase 1 design.

## Context

The original Phase 1 plan installed ACK, kro, and Argo CD into the cluster via Helm (12 charts, 9 Pod Identity associations, cert-manager prereq). Mid-implementation we adopted [EKS Capabilities](https://docs.aws.amazon.com/eks/latest/userguide/capabilities.html) — a managed AWS service that hosts ACK, kro, and Argo CD in the EKS control plane.

## Decision

**Use the managed capability for all three** components:

| Component | Mechanism |
|---|---|
| ACK    | `AWS::EKS::Capability` type `ACK`, with an IAM Capability Role trusted by `capabilities.eks.amazonaws.com` |
| kro    | `AWS::EKS::Capability` type `KRO`, no IAM permissions needed (cluster-only) |
| Argo CD | `AWS::EKS::Capability` type `ARGOCD`, with IdC integration and a hosted UI URL |

External Secrets Operator stays self-managed via Helm — it is not yet available as a capability.

## Rationale

- **Smaller blast radius for a Phase 1 failure.** The em-dash incident dropped 38 resources during rollback. The capabilities path is 12 resources; failures are quicker to diagnose.
- **No control-plane software running on our nodegroups.** Capabilities run in the AWS-managed EKS control plane; our `platform` nodegroup serves workloads only (and Phase 3+ Backstage).
- **AWS owns patches and HA.** A capability upgrade is an `aws eks update-capability`, not a Helm chart bump + dependency soak.
- **Aligns with the AWS-published reference architecture** ([Common use cases](https://docs.aws.amazon.com/eks/latest/userguide/capabilities.html#_common_use_cases)) for "GitOps for Applications and Infrastructure" and "Platform Engineering with Self-Service" — exactly the Fleet vision.
- **CRDs identical to upstream.** ACK CRDs (`s3.services.k8s.aws/v1alpha1.Bucket`, etc.), kro `ResourceGraphDefinition`, Argo `Application` — Phase 2 InfraTemplates and Phase 3 Backstage scaffolder still consume the same APIs.

## Consequences

- **One capability per type per cluster.** No multi-tenant ArgoCD on the same cluster. Fine for v1.
- **IdC required for ArgoCD.** No local-user fallback; we lean on the existing IdC instance.
- **Permissions model shift for ACK.** Phase 1 grants `AdministratorAccess` to the ACK Capability Role to streamline getting started; Phase 7 hardening migrates to [IAM Role Selectors](https://docs.aws.amazon.com/eks/latest/userguide/ack-permissions.html) for namespace-scoped least privilege.
- **Customization narrows.** Per-controller Helm values, custom Dex configs, ArgoCD CSV RBAC tweaks — gone. We accept the AWS-managed surface.
- **Ongoing per-capability hourly cost.** Tracked separately in Cost Explorer via the Phase 6 dashboard.

## Alternatives considered

- **Self-managed Helm install of all three** (original plan). Rejected per the rationale above.
- **Capability for ACK + kro only; Helm for ArgoCD.** Rejected because IdC is available and the managed Argo CD removes the Phase 3 SSO migration step.
- **No managed ArgoCD; use [Argo CD Hub](...) Console.** Not applicable in our region/account.

## What remains self-managed in Phase 1

- **Secrets Store CSI Driver + AWS provider (ASCP)** — mounts secrets from AWS Secrets Manager / SSM directly into workload pods. AWS-native (ASCP is published by AWS), runs as a DaemonSet, no controller pod. Auth is per-workload via Pod Identity on the consumer's service account. Will move to a capability if/when AWS ships one.
