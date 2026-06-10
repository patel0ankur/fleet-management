# ADR 0006 - Secrets Store CSI Driver + ASCP over External Secrets Operator

**Status:** Accepted (2026-06-10), supersedes the ESO portion of the original Phase 1 design.

## Context

Workloads (and ArgoCD repo creds, Backstage tokens, DB passwords) need to consume secrets from AWS Secrets Manager / SSM Parameter Store. Two mature options:

1. **External Secrets Operator (ESO)** - controller pod that reads from any backend and creates Kubernetes `Secret` objects.
2. **Secrets Store CSI Driver + AWS provider (ASCP)** - DaemonSet that mounts secrets directly into pod filesystems via a CSI volume. Optionally syncs to a `Secret` while a referencing pod runs.

## Decision

**Secrets Store CSI Driver + ASCP.**

## Rationale

- **AWS-native.** ASCP is published and maintained by AWS specifically for the Secrets Store CSI Driver.
- **Smaller footprint.** No long-running controller pod; the driver runs as a DaemonSet and the provider is a sidecar that reads on-demand.
- **Pod Identity ergonomics.** Auth is per-workload: each consumer pod's service account gets a Pod Identity association scoped to the secrets it actually needs. No cluster-wide controller role with broad `secretsmanager:*` access.
- **Built-in rotation.** With `enableSecretRotation: true` the driver re-reads on a configurable interval; mounted files update in place.
- **Sync-to-Secret still available.** When a workload genuinely needs a Kubernetes `Secret` (env vars, ArgoCD repository Secret), set `secretObjects` on the `SecretProviderClass` - the driver materializes a Secret while a referencing pod is running.

## Consequences

- **Secret only exists while a referencing pod runs.** This is the headline tradeoff vs ESO. For ArgoCD private-repo creds (Phase 2+) we will either:
  - Use [AWS CodeConnections](https://docs.aws.amazon.com/eks/latest/userguide/argocd-considerations.html) - the Argo CD capability supports it natively, no Secret needed; or
  - Hand-create the ArgoCD repo Secret out-of-band (one-time, kept in Secrets Manager and applied via a small bootstrap pod).
- **Per-workload IAM setup.** Phase 2+ Backstage scaffolder and kro ResourceGroups must template a Pod Identity association alongside any pod that mounts secrets. This is consistent with the rest of Fleet's per-workload IAM model (ACK CRs already follow this pattern).
- **Driver upgrades are Helm bumps** until AWS ships a Secrets Store CSI capability.

## Alternatives considered

- **External Secrets Operator** - originally chosen in Phase 1. Rejected: extra controller pod, broader IAM blast radius for the operator role, less aligned with AWS docs guidance for EKS Secrets Manager integration.
- **Manually `kubectl apply` a Secret with the value baked in** - non-starter for production; secrets in etcd unencrypted-at-source, no rotation.
- **Pod env vars sourced via `aws secretsmanager get-secret-value` in an init container** - works, but reinvents what ASCP already does.
