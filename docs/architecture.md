# Fleet Management — Architecture

Fleet is built as **five planes**, modeled after [OpenChoreo](https://github.com/openchoreo/openchoreo)'s multi-plane design. Each plane handles a distinct concern and operates independently.

| Plane | What lives here | AWS / OSS components |
|---|---|---|
| **Experience** | Where humans (and agents) interact with Fleet | Backstage portal, `fleetctl` CLI, GitOps repo |
| **Control** | Translates platform/developer intent into reality and reflects state back | EKS + **EKS Capabilities** (managed ACK, kro, Argo CD) + Fleet CRDs |
| **CI** | Builds and ships container images / Lambda artifacts | Argo Workflows, Buildpacks, ECR |
| **Data** | Where workloads run | Target AWS accounts, cross-account IAM, optional EKS data clusters, Lambda |
| **Observability** | Metrics, logs, traces, incidents, RCA | CloudWatch, AMP/AMG, AWS DevOps Agent, EventBridge |

A separate **FinOps** capability (Cost Explorer/CUR) feeds back into the Experience plane.

## Boundary: CDK vs GitOps

CDK is the **bootstrap layer only**. It exists to produce a working EKS cluster with ArgoCD wired to a GitOps repo. After that, **every platform component is a folder in the GitOps repo** picked up by the `fleet-bootstrap` ArgoCD Application (App-of-Apps).

CDK is re-run only for:
- EKS version bumps
- New region/account expansion
- Adding a new ACK controller (chart install lives in CDK so the IAM trust comes with it)

Everything else — new InfraTemplates, new Backstage plugins, new Argo Workflows, Fleet CRD changes — is a Git PR.

## Phase 1 deliverable (this repo today)

```
                    ┌──────────────────────────────────────────────┐
                    │    Shared-services AWS account               │
                    │                                              │
                    │   ┌────────────────────────────────────┐     │
                    │   │   EKS control plane (AWS-managed)  │     │
                    │   │                                    │     │
                    │   │   ACK     kro     Argo CD          │     │
                    │   │   (capabilities, fully managed)    │     │
                    │   └─────────────│──────────────────────┘     │
                    │                 │ CRDs surfaced              │
   fleetctl ──cdk── │   ┌─────────────▼──────────────────────┐     │
                    │   │   EKS data plane (our nodegroups)  │     │
                    │   │   Secrets Store CSI Driver + ASCP  │     │
                    │   └────────────────────────────────────┘     │
                    │                                              │
                    │   ECR repos    KMS keys    Argo hosted URL   │
                    │                            (IdC SSO)         │
                    │                                              │
                    │   fleet-bootstrap (Argo App, CDK-created)    │
                    │                   ──watches──►               │
                    │                   GitHub repo (gitops)       │
                    │                   `clusters/control/...`     │
                    └──────────────────────────────────────────────┘
```

## Phase 2+ (not yet implemented)

```
Backstage scaffolder
        │
        ▼
   Deployment CR  ──► PR to gitops repo
                              │
                              ▼
                         ArgoCD applies
                              │
                              ▼
                         kro (ResourceGroup)
                              │
                              ▼
                         ACK controllers
                              │
                              ▼
                         AWS resources
```

## Observability + RCA flow (Phase 5)

```
CloudWatch alarm / Argo Workflow failure
        │
        ▼
EventBridge rule
        │
        ▼
Lambda enricher (attaches Deployment+Project context)
        │
        ▼
AWS DevOps Agent webhook
        │
        ▼
Backstage `fleet-incidents` plugin renders RCA
```

## Cost flow (Phase 6)

- **v1 — Cost Explorer API** every 24h → Prometheus → Grafana → Backstage `fleet-costs`
- **v2 — CUR + Athena** for hourly line-item drilldown

See [decisions/](decisions/) for the rationale behind each major choice.
