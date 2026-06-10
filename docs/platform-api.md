# Fleet Platform API

The Platform API is a small set of CRDs that platform engineers and developers use to drive Fleet. Group is `platform.<org>` (templated; defaults to `platform.acme`).

## v1alpha1 surface

| Kind | Scope | Owner | Purpose |
|---|---|---|---|
| `Project` | Cluster | Platform engineer | Tenancy boundary - K8s namespace + cost-allocation tag + (Phase 3) IdC group bindings. |
| `Deployment` | Namespaced (in the project's namespace) | Developer | Instance of a kro `ResourceGraphDefinition`, scoped to a Project. |

Coming in later phases: `Environment`, `Pipeline`, `IncidentBinding`, `CostPolicy`.

## `Project`

```yaml
apiVersion: platform.acme/v1alpha1
kind: Project
metadata:
  name: payments
spec:
  displayName: "Payments team"
  namespace: payments
  costCenter: "1234-payments"
  owners:
    - { id: <idc-group-id>, type: SSO_GROUP }
```

Phase 2 doesn't yet ship a controller; the namespace is created by a kro `ProjectGraph` instance committed alongside the `Project` CR. Phase 4's Fleet operator will:

- Create the namespace from `spec.namespace`.
- Apply `fleet.platform.acme/cost-center=<value>` as a namespace label.
- Bind `spec.owners[]` to a project-scoped RBAC role (Phase 3 prerequisite).
- Set `status.namespaceCreated` and the `Ready` condition.

## `Deployment`

```yaml
apiVersion: platform.acme/v1alpha1
kind: Deployment
metadata:
  name: api
  namespace: payments
spec:
  template: stateless-service-with-bucket.kro.run
  values:
    name: api
    image: 590443650088.dkr.ecr.us-east-1.amazonaws.com/payments-api:v42
    replicas: 3
    bucketSuffix: events
    costCenter: "1234-payments"
```

`spec.template` references a kro `ResourceGraphDefinition` published by the platform team. `spec.values` is opaque to Fleet and validated by kro at apply time.

Phase 2: the `Deployment` CR is documentation-only; the actual fan-out is driven by a kro instance CR (e.g. `StatelessServiceWithBucket`) committed to the same file. Phase 4's controller adopts the `Deployment` CR and creates the kro instance under it.

## Available templates (RGDs)

| Template | What it provisions |
|---|---|
| [`stateless-service-with-bucket.kro.run`](../templates/stateless-service-with-bucket/README.md) | K8s Deployment + Service + ACK S3 Bucket + IAM Role/Policy + Pod Identity wiring |
| `project.kro.run` (internal) | Materializes a `Project` CR into a labeled namespace |

Add a new template: drop `templates/<name>/rgd.yaml` in this repo, run `make render-gitops`, push.

## Argo orchestration

Two `ApplicationSet`s in `clusters/control/80-applicationsets/projects.yaml` make the API work:

- **`fleet-projects`** - one Argo `Application` per `projects/*/project.yaml`. Sync wave 10.
- **`fleet-workloads`** - one Argo `Application` per `projects/*/deployments` directory. Sync wave 20.

Drop a YAML in `projects/<team>/deployments/<service>.yaml` -> Argo applies it within ~3 minutes -> kro fans it out -> ACK creates AWS resources.
