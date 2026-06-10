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
  echo "usage: $0 <gitops-checkout> [--config config/platform.yaml]" >&2
  exit 1
fi

GITOPS="$1"; shift
CONFIG="config/platform.yaml"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
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

if [[ -z "$ORG" || -z "$CLUSTER_NAME" || -z "$REGION" || -z "$ACCOUNT" ]]; then
  echo "could not extract org/cluster/region/account from $CONFIG" >&2
  echo "  ORG=$ORG CLUSTER_NAME=$CLUSTER_NAME REGION=$REGION ACCOUNT=$ACCOUNT" >&2
  exit 1
fi

CLUSTER_ARN="arn:aws:eks:${REGION}:${ACCOUNT}:cluster/${CLUSTER_NAME}"

echo "==> Rendering with:"
echo "    ORG          = $ORG"
echo "    CLUSTER_NAME = $CLUSTER_NAME"
echo "    CLUSTER_ARN  = $CLUSTER_ARN"
echo "    target       = $GITOPS"

# Run sed once per file; portable BSD/GNU.
substitute() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  sed \
    -e "s|{{ *ORG *}}|$ORG|g" \
    -e "s|{{ *CLUSTER_NAME *}}|$CLUSTER_NAME|g" \
    -e "s|{{ *CLUSTER_ARN *}}|$CLUSTER_ARN|g" \
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

# Smoke fixture
substitute samples/projects/smoke-team/project.yaml \
  "$GITOPS/projects/smoke-team/project.yaml"
substitute samples/projects/smoke-team/deployments/hello.yaml \
  "$GITOPS/projects/smoke-team/deployments/hello.yaml"

echo
echo "==> Done. Review with:  cd $GITOPS && git status -s && git diff"
echo "    Then:               cd $GITOPS && git add -A && git commit -m 'Phase 2' && git push"
