#!/usr/bin/env bash
#
# Render Phase 2 source manifests into a checkout of the GitOps repo.
# Substitutes:
#   {{ ORG }}          - from config/platform.yaml metadata.org
#   {{ CLUSTER_NAME }} - from config/platform.yaml spec.eks.name
#   {{ CLUSTER_ARN }}  - resolved via aws eks describe-cluster
#
# Usage:
#   ./hack/render-gitops.sh /path/to/fleet-gitops [--config config/platform.yaml]
#
# Idempotent. Does NOT git-commit; review and push manually.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <gitops-checkout> [--config config/platform.yaml] [--with-smoke]" >&2
  exit 1
fi

GITOPS="$1"; shift
CONFIG="config/platform.yaml"
WITH_SMOKE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
    --with-smoke) WITH_SMOKE=1; shift ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ ! -d "$GITOPS/.git" ]]; then
  echo "not a git checkout: $GITOPS" >&2; exit 1
fi
if [[ ! -f "$CONFIG" ]]; then
  echo "config not found: $CONFIG" >&2; exit 1
fi

# Pull values out of platform.yaml. Using yq if available, falling back to
# a tiny grep so the script has no external deps for the common case.
read_yaml() {
  local key="$1"
  if command -v yq >/dev/null 2>&1; then
    yq -r ".$key // \"\"" "$CONFIG"
  else
    # crude fallback: matches `  key: value` at any indentation
    awk -v k="${key##*.}" '
      $1 == k":" { sub(/^[^:]*:[[:space:]]*/, ""); gsub(/^["'\''"]|["'\''"]$/, ""); print; exit }
    ' "$CONFIG"
  fi
}

ORG="$(read_yaml metadata.org)"
CLUSTER_NAME="$(read_yaml spec.eks.name)"
REGION="$(read_yaml spec.aws.region)"
ACCOUNT="$(read_yaml spec.aws.sharedServicesAccount)"

# Phase 3 - developer portal (Backstage). All optional; absence skips the
# 40-backstage render block.
DP_ENABLED="$(read_yaml spec.developerPortal.enabled)"
HOST="$(read_yaml spec.developerPortal.host)"
ORG_GH="$(read_yaml spec.developerPortal.githubOrg)"
GITHUB_TOKEN_SECRET_ARN="$(read_yaml spec.developerPortal.githubTokenSecretArn)"
OIDC_CLIENT_SECRET_ARN="$(read_yaml spec.developerPortal.oidcClientSecretArn)"
# Derive the IdC instance ID (the trailing path segment of the instance ARN)
# for Backstage's OIDC metadataUrl. Format:
# arn:aws:sso:::instance/ssoins-XXXXXXXX -> ssoins-XXXXXXXX
IDC_INSTANCE_ARN="$(read_yaml spec.identity.idc.instanceArn)"
IDC_INSTANCE_ID="${IDC_INSTANCE_ARN##*/}"

if [[ -z "$ORG" || -z "$CLUSTER_NAME" || -z "$REGION" || -z "$ACCOUNT" ]]; then
  echo "could not extract org/cluster/region/account from $CONFIG" >&2
  echo "  ORG=$ORG CLUSTER_NAME=$CLUSTER_NAME REGION=$REGION ACCOUNT=$ACCOUNT" >&2
  exit 1
fi

CLUSTER_ARN="arn:aws:eks:${REGION}:${ACCOUNT}:cluster/${CLUSTER_NAME}"

echo "==> Rendering with:"
echo "    ORG          = $ORG"
echo "    REGION       = $REGION"
echo "    CLUSTER_NAME = $CLUSTER_NAME"
echo "    CLUSTER_ARN  = $CLUSTER_ARN"
echo "    target       = $GITOPS"
if [[ "$DP_ENABLED" == "true" ]]; then
  echo "    HOST         = $HOST"
  echo "    ORG_GH       = $ORG_GH"
fi

# Run sed once per file; portable BSD/GNU.
substitute() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  sed \
    -e "s|{{ *ORG *}}|$ORG|g" \
    -e "s|{{ *REGION *}}|$REGION|g" \
    -e "s|{{ *CLUSTER_NAME *}}|$CLUSTER_NAME|g" \
    -e "s|{{ *CLUSTER_ARN *}}|$CLUSTER_ARN|g" \
    -e "s|{{ *HOST *}}|$HOST|g" \
    -e "s|{{ *ORG_GH *}}|$ORG_GH|g" \
    -e "s|{{ *GITHUB_TOKEN_SECRET_ARN *}}|$GITHUB_TOKEN_SECRET_ARN|g" \
    -e "s|{{ *OIDC_CLIENT_SECRET_ARN *}}|$OIDC_CLIENT_SECRET_ARN|g" \
    -e "s|{{ *IDC_INSTANCE_ID *}}|$IDC_INSTANCE_ID|g" \
    "$src" > "$dst"
  echo "    rendered $src -> $dst"
}

# CRDs
substitute crds/0010-project.yaml    "$GITOPS/clusters/control/20-fleet-crds/project-crd.yaml"
substitute crds/0020-deployment.yaml "$GITOPS/clusters/control/20-fleet-crds/deployment-crd.yaml"

# kro RGDs
substitute templates/project/rgd.yaml \
  "$GITOPS/clusters/control/30-infratemplates/project.yaml"
substitute templates/stateless-service-with-bucket/rgd.yaml \
  "$GITOPS/clusters/control/30-infratemplates/stateless-service-with-bucket.yaml"

# ApplicationSets
substitute templates/applicationsets/projects.yaml \
  "$GITOPS/clusters/control/80-applicationsets/projects.yaml"

# Phase 3 - Backstage (opt-in via spec.developerPortal.enabled).
if [[ "$DP_ENABLED" == "true" ]]; then
  if [[ -z "$HOST" || -z "$ORG_GH" || -z "$GITHUB_TOKEN_SECRET_ARN" || -z "$OIDC_CLIENT_SECRET_ARN" ]]; then
    echo "developerPortal.enabled=true but required fields are missing:" >&2
    echo "  HOST=$HOST ORG_GH=$ORG_GH" >&2
    echo "  GITHUB_TOKEN_SECRET_ARN=$GITHUB_TOKEN_SECRET_ARN" >&2
    echo "  OIDC_CLIENT_SECRET_ARN=$OIDC_CLIENT_SECRET_ARN" >&2
    exit 1
  fi
  substitute templates/backstage/namespace.yaml \
    "$GITOPS/clusters/control/40-backstage/00-namespace.yaml"
  substitute templates/backstage/secretproviderclass.yaml \
    "$GITOPS/clusters/control/40-backstage/10-spc.yaml"
  substitute templates/backstage/serviceaccount.yaml \
    "$GITOPS/clusters/control/40-backstage/20-serviceaccount.yaml"
  substitute templates/backstage/rbac.yaml \
    "$GITOPS/clusters/control/40-backstage/50-rbac.yaml"
  substitute templates/backstage/application.yaml \
    "$GITOPS/clusters/control/40-backstage/30-application.yaml"
  substitute templates/backstage/values.yaml \
    "$GITOPS/clusters/control/40-backstage/values.yaml"
  # Shared org users (guest) so Group memberships resolve in the catalog.
  substitute templates/backstage/org/users.yaml \
    "$GITOPS/clusters/control/40-backstage/org/users.yaml"
  # Scaffolder template (registered via catalog.locations in values.yaml).
  substitute templates/backstage/scaffolder/stateless-service-with-bucket/template.yaml \
    "$GITOPS/clusters/control/40-backstage/scaffolder/stateless-service-with-bucket/template.yaml"
  # Skeleton has literal Backstage `${{ values.* }}` placeholders that must
  # survive the render. The substitute() function only touches `{{ FOO }}`
  # tokens, so we copy this tree verbatim.
  mkdir -p "$GITOPS/clusters/control/40-backstage/scaffolder/stateless-service-with-bucket/skeleton"
  cp -R templates/backstage/scaffolder/stateless-service-with-bucket/skeleton/. \
    "$GITOPS/clusters/control/40-backstage/scaffolder/stateless-service-with-bucket/skeleton/"
  echo "    copied scaffolder skeleton (verbatim)"
else
  # developerPortal disabled: actively REMOVE any previously-rendered
  # 40-backstage so a stale directory doesn't keep getting deployed by the
  # fleet-bootstrap Argo App (which syncs everything under clusters/control/
  # regardless of the CDK flag). Without this, disabling the portal in
  # platform.yaml leaves Backstage running in the cluster.
  if [[ -d "$GITOPS/clusters/control/40-backstage" ]]; then
    rm -rf "$GITOPS/clusters/control/40-backstage"
    echo "    removed stale 40-backstage (developerPortal.enabled=false)"
  else
    echo "    (developerPortal.enabled=false; no 40-backstage to render)"
  fi
fi

# Smoke fixture (opt-in; use --with-smoke). Without it, fresh adopters don't
# accidentally provision an S3 bucket they didn't ask for.
if [[ "$WITH_SMOKE" == "1" ]]; then
  substitute samples/projects/smoke-team/project.yaml \
    "$GITOPS/projects/smoke-team/project.yaml"
  substitute samples/projects/smoke-team/deployments/hello.yaml \
    "$GITOPS/projects/smoke-team/deployments/hello.yaml"
  # No catalog-info/components rendered: the FleetEntityProvider auto-derives
  # the Group/System/Component for smoke-team from its kro instance once the
  # workload is provisioned.
else
  echo "    (skipping smoke fixture; pass --with-smoke to include it)"
fi

echo
echo "==> Done. Review with:  cd $GITOPS && git status -s && git diff"
echo "    Then:               cd $GITOPS && git add -A && git commit -m 'Phase 3' && git push"
