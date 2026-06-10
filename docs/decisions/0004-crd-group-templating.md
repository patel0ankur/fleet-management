# ADR 0004 — Templated CRD group per org

**Status:** Accepted (2026-06-10)

## Context

The Phase 2 Fleet CRDs (`InfraTemplate`, `Environment`, `Project`, `Deployment`, `Pipeline`, `IncidentBinding`, `CostPolicy`) need an API group. Two approaches:

1. Ship with a fixed group like `platform.fleet.dev`.
2. Template the group per adopter from `metadata.org` in `platform.yaml`. Group becomes `platform.<org>` (e.g. `platform.acme`).

## Decision

**Template per org.** The CRD manifests in `crds/` (Phase 2) are rendered at install time using `metadata.org`.

## Rationale

- Adopters won't accept third-party API groups in their internal namespaces. `platform.acme` reads as a first-party API; `platform.fleet.dev` reads like a vendor.
- Avoids accidental collision if multiple platforms (Fleet + a homegrown one) coexist on the same cluster.
- Keeps the door open for forks and white-labeling without rewriting kubebuilder annotations.

## Consequences

- We can't ship pre-built CRD YAMLs; Phase 2 install logic must template them. Acceptable — the install is a one-shot Helm or Kustomize render driven by `platform.yaml`.
- Webhooks, Backstage plugins, and `kubectl` examples must reference the templated group, not a hardcoded one.
- Cross-Fleet portability of `Deployment` manifests requires a small rewrite (`sed s/platform.<src>/platform.<dst>/`). Worth it.

## Alternatives considered

- **Single shared group `platform.fleet.dev`** — simpler, but adopters pushed back. Rejected.
- **Group per CRD (`infra.fleet.dev`, `pipeline.fleet.dev`)** — finer-grained but doesn't solve the vendor-name problem and adds RBAC complexity.
