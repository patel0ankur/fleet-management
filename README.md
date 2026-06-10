# Fleet Management

A self-hosted Internal Developer Platform for AWS that platform engineers deploy into their own organization. Fleet gives developers golden-path infrastructure provisioning via Backstage, GitOps delivery via ArgoCD, automated incident RCA via AWS DevOps Agent, and cost visibility — without each team stitching the toolchain together.

Inspired by [OpenChoreo](https://github.com/openchoreo/openchoreo)'s multi-plane architecture, but built natively on AWS + EKS capabilities.

## Status

**Phase 0 → 1 (Foundation + Bootstrap).** Produces a working EKS control cluster with ArgoCD, ACK, and kro installed and wired to a GitOps repo. Backstage, Platform CRDs, DevOps Agent, and cost reporting land in later phases.

## Architecture

Five planes, mirroring OpenChoreo:

| Plane | Components |
|---|---|
| **Experience** | Backstage portal, `fleetctl` CLI, GitOps repo |
| **Control** | EKS + ArgoCD + kro + ACK controllers + Fleet CRDs |
| **CI** | Argo Workflows + Buildpacks + ECR |
| **Data** | Target AWS accounts (workloads), cross-account IAM |
| **Observability** | CloudWatch + Managed Prometheus + AWS DevOps Agent |

CDK is the **bootstrap layer only**. After day-1, everything is GitOps.

See [docs/architecture.md](docs/architecture.md) for the full picture.

## Quick start (Phase 1)

```bash
git clone <this-repo> && cd fleet_infra
cp config/platform.example.yaml config/platform.yaml
$EDITOR config/platform.yaml          # fill in account, region, gitops repo
make tools-check
fleetctl init
fleetctl deploy                       # ~30-40 min
fleetctl status                       # all green
```

See [docs/getting-started.md](docs/getting-started.md).

## Repo layout

| Path | Contents |
|---|---|
| [bin/](bin/) | CDK app entry |
| [lib/stacks/](lib/stacks/) | `BootstrapStack`, `PlatformStack` |
| [lib/constructs/](lib/constructs/) | Reusable L3s (VPC, EKS, ACK, ArgoCD, kro) |
| [config/](config/) | `platform.yaml` schema + example |
| [cli/fleetctl/](cli/fleetctl/) | Go CLI |
| [docs/](docs/) | Architecture, ADRs, runbooks |
| [crds/](crds/), [templates/](templates/), [charts/](charts/) | Placeholders for Phase 2+ |

## License

Apache-2.0. See [LICENSE](LICENSE).
