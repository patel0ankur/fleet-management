# ADR 0001 — CDK is the bootstrap layer only

**Status:** Accepted (2026-06-10)

## Context

A fleet of platform components (ArgoCD, ACK, kro, Backstage, Argo Workflows, External Secrets, ingress, observability stack…) must be installed and kept up to date on the EKS control cluster. There are two reasonable models:

1. Manage all of that with CDK — every chart is a `cluster.addHelmChart(...)` somewhere in `lib/stacks/`.
2. Use CDK only to bring the cluster + GitOps engine to life, and let GitOps manage everything else.

## Decision

We use **CDK for bootstrap only**. After Phase 1, every platform component is a folder in the GitOps repo, applied by ArgoCD via an App-of-Apps Application named `fleet-bootstrap`.

CDK is re-run only for:
- EKS version bumps
- Region/account expansion
- Adding a new ACK controller (the chart install carries IAM trust setup)

## Rationale

- **Drift detection.** ArgoCD continuously reconciles. CDK only sees state at deploy time.
- **Day-2 surface.** CDK redeploys are slow and require AWS creds. PRs to a Git repo are fast and reviewable.
- **Operator UX.** Platform engineers expect "kubectl + Git." Running `cdk deploy` for a Helm value bump is friction.
- **Choreo precedent.** OpenChoreo uses the same split — Helm install for substrate, GitOps for everything in front of users.

## Consequences

- We need to ship and version the GitOps repo content as a first-class artifact (Phase 2+).
- Adding a new ACK controller crosses the boundary (IAM in CDK + chart in CDK). We accept this cost — the alternative is to write IRSA-by-hand in YAML, which is worse.
- Cluster upgrades remain a CDK operation; we will write a separate runbook for them.

## Alternatives considered

- **Pulumi/Terraform instead of CDK.** No win for the AWS-native bootstrap layer; CDK gives us L3 constructs and Pod Identity ergonomics.
- **CDK for everything.** Rejected — see "Day-2 surface" above.
