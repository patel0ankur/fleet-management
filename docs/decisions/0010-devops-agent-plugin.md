# ADR 0010 - DevOps Agent incidents/RCA as a Backstage plugin

**Status:** Accepted (2026-06-12). Supersedes a first, withdrawn attempt
(an EventBridge -> Lambda -> IncidentBinding-CRD pipeline) that was the wrong
architecture.

## Context

Phase 5: surface AWS DevOps Agent incidents + RCA for Fleet workloads. The
first implementation built a push pipeline (CloudWatch/EventBridge -> an
incident-enricher Lambda -> an IncidentBinding CRD -> the catalog provider).
It worked end-to-end but was the wrong shape: heavy infrastructure (Lambda,
CRD, EventBridge, EKS access entry) for what is fundamentally a *read-and-show*
feature.

The reference pattern is **awslabs/backstage-plugins-for-aws** (e.g. the
`securityhub` plugin): a Backstage plugin in three packages
(frontend / backend / common) where the **backend calls the AWS API at request
time** and the **frontend renders an entity tab**, with entities opting in via
an **annotation**. No Lambda, no CRD, no event bus.

## Decision

**Build a DevOps Agent Backstage plugin in the SecurityHub shape.** Three
workspace packages under `backstage/plugins/devops-agent-{common,backend,
frontend}`, compiled into the Fleet custom image:

- **common** (`@internal/plugin-devops-agent-common`): the annotation
  `aws.amazon.com/devops-agent-tags` + shared types.
- **backend** (`@internal/plugin-devops-agent-backend`): a `createBackendPlugin`
  exposing `GET /api/devops-agent/incidents?entityRef=`. It reads the entity's
  `devops-agent-tags` annotation (via the catalog) and calls the `aidevops`
  API (`ListBacklogTasks`) for the configured agentSpace at request time,
  filtering investigations to the entity's tags. AWS credentials come from the
  default chain = the Backstage pod's **EKS Pod Identity** role (CDK grants it
  `aidevops:*` read actions when `observability.devopsAgent.enabled`).
- **frontend** (`@internal/plugin-devops-agent`): an "Incidents" entity tab via
  the **new frontend system** (`EntityContentBlueprint`), shown only for
  entities whose annotation is present (function-form `filter`). Note: the
  SecurityHub reference uses the OLD frontend system (`createRoutableExtension`)
  - we adapted to `createFrontendPlugin` + `EntityContentBlueprint` because the
  Fleet app uses the new system.

The `FleetEntityProvider` stamps `aws.amazon.com/devops-agent-tags:
service=<name>,project=<ns>` on every Component, so all Fleet workloads get the
tab automatically. Config: `spec.observability.devopsAgent {enabled,
agentSpaceId, region}` -> rendered into the chart's
`aws.devopsAgent.{agentSpaceId,region}` app-config.

## Rationale

- **Right altitude:** incidents/RCA is a view over an AWS API; a request-time
  plugin is far simpler than standing up an event pipeline + CRD + Lambda, and
  matches the AWS-published pattern so future awslabs plugins drop in the same
  way.
- **No new infra:** zero Lambda/CRD/EventBridge. The only AWS-side change is
  `aidevops:*` read actions on the existing Backstage Pod Identity role.
- **Annotation-driven, like SecurityHub:** entities opt in; our provider sets
  the annotation so it's automatic for Fleet workloads but still works for any
  hand-authored entity.

## Consequences

- **Graceful when unconfigured:** with no `agentSpaceId`, the backend returns
  `{configured:false}` and the tab shows "not configured" - no crash. (Required
  reading the config with `getOptional`+coerce, not `getOptionalString`, which
  throws on an empty string.)
- **agentSpace is one-time, in-console setup** (CreateAgentSpace + the agent's
  "EKS Access Setup" capability). Set `agentSpaceId` in platform.yaml to light
  it up; no redeploy of the plugin needed beyond a Backstage roll.
- **Tag matching is text-based:** `ListBacklogTasks` has no structured tag
  filter, so the backend matches investigations whose title/description contain
  the tag values. When the plugin *opens* an investigation it embeds the tag
  set in the title (`Investigate <name> [service=…,project=…]`) so the same
  Component's list filter picks it up. We do **not** set `CreateBacklogTask`'s
  `reference` (ReferenceInput): although it looks like the natural place for the
  entity ref, its `system` field is validated server-side against *registered
  data-plane integrations* (a free-text `'backstage'` is rejected with
  `Unknown data plane service name`), so the reference is unusable for an
  arbitrary external system. Title-embedding is the working mechanism.
- **Withdrawn pipeline removed:** IncidentBinding CRD, incident-enricher Lambda,
  IncidentPipeline construct, incident RBAC, and the provider's incident code
  were all deleted (commit "revert(phase5)...").

## Future
- ~~Let Fleet *open* investigations from an action.~~ **Shipped:** the Incidents
  tab has a **"Start investigation"** button → `POST /api/devops-agent/
  investigations` → `CreateBacklogTask` (taskType `INVESTIGATION`) in the
  configured agentSpace. The entity's tags are embedded in the task title so it
  surfaces back on the same Component's tab.
- Surface `ListJournalRecords` / `GetRecommendation` (the RCA detail) in a
  drawer, like SecurityHub's FindingDrawer.
- Wire a structured entity↔investigation link if/when DevOps Agent exposes one
  (the `reference` field requires a registered data-plane `system`, so it can't
  carry an arbitrary Backstage entity ref today — see Consequences).
