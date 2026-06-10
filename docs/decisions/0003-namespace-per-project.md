# ADR 0003 — Namespace-per-Project for tenancy

**Status:** Accepted (2026-06-10)

## Context

Fleet's `Project` abstraction (Phase 2) is the tenancy boundary. Two implementation options are realistic:

1. One Kubernetes Namespace per Project on the shared control plane.
2. One vCluster (or full EKS cluster) per Project for hard isolation.

## Decision

**Namespace-per-Project for v1.** Each Project CR creates a namespace, baseline NetworkPolicies, ResourceQuotas, a Pod Identity association for ACK-provisioned roles, and RBAC bound to the project's IdP group.

## Rationale

- Fits >90% of internal-platform use cases.
- ~10× cheaper than per-tenant clusters; doesn't need cluster lifecycle automation.
- Compatible with namespace-scoped ACK CRs and per-namespace ArgoCD AppProjects.
- vCluster can be added later as a `Project.spec.isolation: vcluster` opt-in without breaking the v1 contract.

## Consequences

- **Soft isolation only.** A bad operator or compromised pod with cluster-scoped CRD access can break neighbors. Mitigations: NetworkPolicy default-deny, restrict cluster-scoped CRD edits to platform admins, OPA/Kyverno for namespace boundaries.
- We must enforce that no team gets `cluster-admin` on the control cluster. Backstage and ArgoCD are the only routes to apply manifests in production.

## v2 trigger

Move to vCluster (or per-tenant data clusters) when any of:
- A regulated tenant requires hard isolation (PCI/HIPAA/FedRAMP).
- Cross-tenant noisy-neighbor incidents become recurring.
- A tenant needs a Kubernetes version different from the control plane.
