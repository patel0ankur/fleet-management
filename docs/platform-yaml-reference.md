# `platform.yaml` Reference

Source of truth: [config/platform.schema.json](../config/platform.schema.json). This page summarizes; the schema enforces.

## Top-level

| Field | Required | Notes |
|---|---|---|
| `apiVersion` | yes | must be `fleet.platform/v1` |
| `kind` | yes | must be `PlatformConfig` |
| `metadata.name` | yes | DNS-safe, prefixes every CDK stack |
| `metadata.org` | yes | drives `platform.<org>` CRD group |
| `spec` | yes | see below |

## `spec.aws`

| Field | Required | Notes |
|---|---|---|
| `sharedServicesAccount` | yes | 12-digit account id |
| `region` | yes | e.g. `us-west-2`, `eu-central-1` |
| `tags` | no | applied to every CDK-managed resource |

## `spec.network`

| Field | Default | Notes |
|---|---|---|
| `vpcCidr` | `10.40.0.0/16` | IPv4 CIDR |
| `azCount` | `3` | 2-6 |
| `natGateways` | `1` | cost vs HA tradeoff |
| `publicAccessCidrs` | `[]` | if non-empty, restrict EKS public endpoint |

## `spec.eks`

| Field | Required | Notes |
|---|---|---|
| `name` | yes | EKS cluster name |
| `version` | yes | `1.30` or `1.31` |
| `nodeGroups` | yes | array; at least one |

Each node group:

| Field | Required | Notes |
|---|---|---|
| `name` | yes | DNS-safe |
| `instanceTypes` | yes | array, at least one |
| `minSize` / `maxSize` | yes | `maxSize` ≥ `minSize` |
| `desiredSize` | no | within [min, max] |
| `labels` | no | k=v |
| `taints` | no | NO_SCHEDULE / PREFER_NO_SCHEDULE / NO_EXECUTE |

## `spec.gitops`

| Field | Required | Notes |
|---|---|---|
| `repoUrl` | yes | https or git@ URL |
| `branch` | default `main` | |
| `pathPrefix` | default `clusters/control` | watched by `fleet-bootstrap` |
| `sshKeySecretArn` | conditional | required if `repoUrl` starts with `git@` or `ssh://` |
| `tokenSecretArn` | conditional | for HTTPS private repos |

## `spec.capabilities`

| Field | Default | Notes |
|---|---|---|
| `ack` | `true` | Create the [ACK EKS Capability](https://docs.aws.amazon.com/eks/latest/userguide/create-ack-capability.html). |
| `kro` | `true` | Create the [kro EKS Capability](https://docs.aws.amazon.com/eks/latest/userguide/create-kro-capability.html). |
| `argocd` | `true` | Create the [Argo CD EKS Capability](https://docs.aws.amazon.com/eks/latest/userguide/create-argocd-capability.html). Requires `spec.identity.idc`. |

## `spec.identity.idc`

Required (the Argo CD capability cannot be created without it).

| Field | Required | Notes |
|---|---|---|
| `instanceArn` | yes | `aws sso-admin list-instances` |
| `region` | yes | Region of the IdC instance |
| `adminGroupId` | yes | IdC group/user assigned Argo CD ADMIN. `aws identitystore list-groups --identity-store-id <id>` |
| `adminGroupType` | no | `SSO_GROUP` (default) or `SSO_USER` |

## `spec.observability`, `spec.cost`

Placeholders. Validated as ARN format (when set) for forward compatibility; not consumed in Phase 1.
