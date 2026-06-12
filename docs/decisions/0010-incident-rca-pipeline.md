# ADR 0010 - Incident / RCA pipeline via AWS DevOps Agent

**Status:** Accepted (2026-06-12)

## Context

Phase 5 of the original vision: incident detection + root-cause analysis. The
repo pre-staged it (an `incident-enricher` ECR repo, a
`observability.devopsAgentWebhookSecretArn` config field, an architecture-doc
flow). We needed to verify what AWS DevOps Agent actually is and wire Fleet to
it.

**Verified (docs.aws.amazon.com/devopsagent + APIReference):** AWS DevOps Agent
is real - an AI incident-response agent (investigations, mitigation plans,
prevention). IAM prefix `aidevops`; principal `aidevops.amazonaws.com`. It has
**two** ingress paths: an HMAC/Bearer generic **webhook**, and a full **API**
(`devops-agent-2026-01-01`, SDK `@aws-sdk/client-devops-agent`) with
`CreateBacklogTask` (taskType `INVESTIGATION`) to open investigations and
`ListExecutions` to read progress. It then *pulls* your CloudWatch/EKS/logs
(via its "EKS Access Setup" capability) to do the RCA.

## Decision

**Build an EventBridge -> enricher-Lambda -> DevOps Agent API -> IncidentBinding
CR -> Backstage pipeline, using the API (`CreateBacklogTask`/`ListExecutions`),
not the webhook.**

1. **`IncidentBinding` CRD** (`platform.{{ORG}}/v1alpha1`, namespaced): binds a
   workload (`spec.deploymentRef.name` = the kro instance name) to its
   CloudWatch alarms; `.status.activeIncidents[]` holds the live incident +
   investigation linkage (`taskId`, `executionId`, `executionStatus`, `rcaUrl`).
2. **incident-enricher Lambda** (Node, `@aws-sdk/client-devops-agent`, reuses
   the bootstrap ECR repo): one image, two entry paths -
   - *enricher* (EventBridge `aws.cloudwatch` Alarm State Change + `fleet.argo`
     events): match the IncidentBinding, `CreateBacklogTask({taskType:
     INVESTIGATION})`, patch CR status.
   - *poller* (scheduled): `ListExecutions({taskId})` -> update RCA status.
   It reaches the cluster API with its IAM role via an **EKS access entry**
   bound to the K8s group `fleet-incident-writers` (a ClusterRole grants that
   group patch on `incidentbindings/status`).
3. **CDK `IncidentPipeline`** construct, gated on
   `observability.devopsAgent.enabled`.
4. **Backstage**: the `FleetEntityProvider` reads IncidentBindings and adds
   `fleet.platform.acme/incidents-open`, `incident-max-severity`,
   `incident-status` annotations + RCA links to the workload's Component.

**Graceful degradation:** if `agentSpaceId` is unset, the enricher records the
incident in CR status with `agentSkipped:true` / `AGENT_DISABLED` and skips the
agent call - the whole pipeline is demoable before the DevOps Agent agentSpace
exists. Verified end-to-end: a synthetic `fleet.argo` event produced
`incidentbinding/soxl .status.activeIncidents[0]` and the soxl Backstage
Component showing `incidents-open: 1, severity HIGH`.

## Rationale

- **API over webhook:** `CreateBacklogTask` returns a `taskId`/`executionId` we
  can store and poll (`ListExecutions`) for real RCA progress - the webhook
  gives no handle back. IAM-auth'd (no HMAC signing). The webhook remains a
  documented fallback (`devopsAgentWebhookSecretArn`).
- **CR as the incident read-model:** reuses the FleetEntityProvider we already
  built (cluster state = catalog); incidents appear on Components with no extra
  service or datastore. `.status` is current-state (delete the binding and the
  incident clears) - durable history is a later add.
- **EKS access entry + RBAC group** for the Lambda mirrors how the rest of the
  platform grants cluster access (least privilege: read + patch
  incidentbindings/status only).

## Consequences

- **One-time, out-of-band setup** the operator must do in the DevOps Agent
  console before RCA fields populate: create an **agentSpace** (set
  `observability.devopsAgent.agentSpaceId`) and run the **EKS Access Setup**
  capability so the agent can introspect this cluster.
- **Lambda image must be a Docker v2 manifest** (`--provenance=false
  --output type=docker`) - buildx's default OCI/attestation manifest is
  rejected by Lambda ("image manifest media type not supported").
- **Argo bootstrap App excludes `**/org/**`** (in addition to `scaffolder/**`
  and `values.yaml`) - those are Backstage catalog entities (`backstage.io`
  kinds), not K8s resources; without the exclude one failing `User/guest` apply
  blocks the whole sync.
- **fleet.argo events have no emitter yet** - the rule accepts them; shipping
  the in-cluster Argo exit-handler/`PutEvents` is a follow-up. CloudWatch
  alarms work today.

## Future
- Populate real `rcaUrl`/RESOLVED transitions once an agentSpace is live (the
  poller + ListExecutions are already wired).
- Argo `PutEvents` exit-handler (IRSA) for workflow-failure incidents.
- Durable incident history (DynamoDB) beyond `.status` current-state.
- A dedicated Backstage `fleet-incidents` frontend card (today: annotations +
  links on the stock About card).
