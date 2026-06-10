# ADR 0007 - Platform repo vs workload repo split

**Status:** Accepted (2026-06-10)

## Context

Fleet stores manifests in Git. Two distinct content lifecycles need a home:

1. **Platform-level mechanism** - CRDs, kro `ResourceGraphDefinition`s (the golden paths), `ApplicationSet`s, cluster-wide addons. Owned by the platform team.
2. **Workload-level content** - per-team `Project` CRs, `Deployment` CRs, app code, environment overrides. Owned by developer teams.

Putting both in one repo conflates audit trails, RBAC, and review velocity (a CRD edit and a service deploy now share a CODEOWNERS file).

## Decision

**Two repo classes**:

| Class | Examples | Owner | Contents |
|---|---|---|---|
| **Platform GitOps repo** (one) | `patel0ankur/fleet-gitops` | Platform team | `clusters/control/...` (CRDs, RGDs, ApplicationSets, addons) and `projects/*/` (Project + Deployment CRs registered with the platform) |
| **Workload repo** (many - one per team or service) | e.g. `payments-team/orders-service` | Developer team | Service code, env values, optional kustomize overlays |

For Phase 2 only the platform repo is in play. Phase 3 (Backstage) introduces workload repos and the Backstage scaffolder writes to both.

## Rationale

- **Different review velocities.** Platform CRD edits are rare and risky; service deploys are frequent and bounded. CODEOWNERS for `clusters/control/` (platform team) is different from `projects/payments-team/` (payments team).
- **Different audit needs.** Platform changes go through change management; service deploys are tracked per team.
- **Backstage natural fit.** Phase 3's scaffolder creates a workload repo, then opens a small PR against the platform repo (`projects/<team>/deployments/<svc>.yaml`) registering it.
- **Argo's `ApplicationSet` makes it cheap.** One `ApplicationSet` watches `projects/*/deployments/` in the platform repo and synthesizes one `Application` per directory; that `Application` can then point at the workload repo. No per-service Argo manifest.

## Consequences

- **Auth for private repos** is per-repo. We use AWS CodeConnections (the Argo CD capability supports it natively); a single connection covers all GitHub repos in an org.
- **Workload repos must follow a convention** (e.g. `deploy/` directory, or a `fleet.yaml` marker). Phase 3 documents this.
- **Cross-repo PRs** are needed for "register a new service": one PR in the workload repo (initial code) and one in the platform repo (`Deployment` CR). The Backstage scaffolder opens both.

## Alternatives considered

- **One mega-repo for everything** - rejected; CODEOWNERS and review velocity become a mess at 10+ teams.
- **Repo per service, no platform repo** - rejected; the platform itself needs a home for CRDs/RGDs/ApplicationSets that's not coupled to any team's release cadence.
- **Platform repo + per-team repos (one per team)** - reasonable middle ground; deferred. v1 is one workload repo per service so onboarding stays simple.
