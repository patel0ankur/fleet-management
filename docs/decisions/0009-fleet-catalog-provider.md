# ADR 0009 - Fleet catalog provider (cluster-sourced Backstage entities)

**Status:** Accepted (2026-06-12)

## Context

Phase 3 shipped Backstage with a **file-based** catalog: each service needed a
hand-authored `catalog-info.yaml` committed to `fleet-gitops`, picked up by
`catalog.locations` URL globs. Bring-up exposed how fragile that is:

- The scaffolder had to emit a `catalog-info.yaml` alongside the kro CR, and we
  fought a chain of issues getting it ingested (branch-vs-main registration,
  GitHub read-consistency, unsubstituted `{{ ORG }}` tokens breaking entity
  validation, per-project files overwriting each other for multi-service
  projects).
- The catalog drifted from reality: a `catalog-info.yaml` says nothing about
  whether the workload is actually `ACTIVE`, what bucket it provisioned, etc.

OpenChoreo solves this with a custom **`OpenChoreoEntityProvider`** that reads
their control-plane API and emits Backstage entities live. Fleet is
GitOps-native (no API server), but the **kro instances in the cluster are an
equivalent source of truth** - and we already grant Backstage read access to
them for the Kubernetes plugin.

## Decision

**Auto-derive Backstage catalog entities from kro instances via a custom
`EntityProvider`, and stop hand-authoring `catalog-info.yaml` for workloads.**

The provider (`plugins/catalog-backend-module-fleet`, a
`catalog-backend-module` baked into the Fleet image) runs on a scheduler,
lists `statelessservicewithbucket.kro.run` cluster-wide using the Backstage
pod's in-cluster ServiceAccount token, and emits:

| Source | Backstage entity |
|---|---|
| each namespace that has instances | `Group` (type team, member `guest`) + `System` |
| each kro instance | `Component` - `owner: group:default/<ns>`, `system: system:default/<ns>`, annotated `backstage.io/kubernetes-id` (live workload link), `fleet.platform.acme/kro-state`, `.../bucket-arn`, `.../cost-center`; description shows the live kro state |

`catalog.locations` now only carries the scaffolder `Template` and a shared
`guest` `User`. The scaffolder emits **only the kro CR** - the provider turns
that into the catalog entity once it's applied.

## Rationale

- **The catalog reflects reality.** A Component shows `kro-state: ACTIVE` and
  the actual `bucket-arn` because they're read from the live instance, not a
  static file. Verified: `component:default/soxl` is `managed-by
  fleet-provider:soxl/soxl` with `kro-state=ACTIVE`,
  `bucket-arn=arn:aws:s3:::soxl-app-soxl`.
- **No catalog drift / no hand-authoring.** Scaffolding a service is one kro
  CR; the entity appears automatically. Removes the per-project overwrite bug
  and the entire branch-registration dance.
- **Matches the OpenChoreo shape** while staying GitOps-native: the cluster is
  the source, kro instances stand in for OpenChoreo's API objects.

## Consequences

- **The Fleet image is now genuinely custom** (was already, for the scaffolder
  GitHub module). `@internal/plugin-catalog-backend-module-fleet` is a
  workspace plugin compiled into `fleet/backstage:<tag>`.
- **RBAC dependency:** the `backstage` SA needs cluster read on `kro.run`
  (granted by `50-rbac.yaml`). The provider uses `kc.loadFromCluster()`.
- **Entities are ephemeral with the workload:** delete the kro instance and the
  catalog entity disappears on the next refresh (full mutation). That's
  correct for runtime-sourced entities; durable docs/ownership that should
  outlive a workload would still be file-based.
- **Refresh latency:** default 60s (`fleet.catalog.refreshSeconds`).

## Alternatives considered

- **Keep file-based `catalog-info.yaml`.** Rejected - the drift + scaffolder
  fragility + multi-service overwrite were exactly what motivated this.
- **kubernetes-ingestor plugin.** A community plugin that ingests from K8s
  annotations. Heavier and less precise than reading our own kro CRs directly.
- **Read the `Project`/`Deployment` platform CRs instead of kro instances.**
  Those CR *instances* don't currently exist (the scaffolder creates kro
  instances directly); revisit when the Phase 4 Fleet operator makes
  `Deployment` CRs the front door.

## Future

- Surface the ACK `Bucket`/`Role`/`PodIdentityAssociation` as Backstage
  `Resource` entities related to the Component (the provider already reads the
  bucket ARN; emitting Resources + `dependsOn` relations is incremental).
- When the Phase 4 operator introduces real `Project`/`Deployment` CRs, switch
  the provider's source from kro instances to those for a cleaner mapping.
