#!/usr/bin/env bash
set -euo pipefail

required=(node npm npx aws kubectl helm go)
optional=(cdk argocd)

missing=()

echo "==> Checking required tools"
for t in "${required[@]}"; do
  if ! command -v "$t" >/dev/null 2>&1; then
    missing+=("$t")
    printf "  \033[31m✗\033[0m %s (missing)\n" "$t"
  else
    printf "  \033[32m✓\033[0m %-8s %s\n" "$t" "$(command -v "$t")"
  fi
done

echo
echo "==> Checking optional tools"
for t in "${optional[@]}"; do
  if ! command -v "$t" >/dev/null 2>&1; then
    printf "  \033[33m·\033[0m %s (not installed; OK if using npx)\n" "$t"
  else
    printf "  \033[32m✓\033[0m %-8s %s\n" "$t" "$(command -v "$t")"
  fi
done

if (( ${#missing[@]} > 0 )); then
  echo
  echo "Missing required tools: ${missing[*]}" >&2
  exit 1
fi

echo
echo "==> Checking AWS credentials"
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "  AWS credentials not configured. Run 'aws configure' or export AWS_PROFILE." >&2
  exit 1
fi
caller=$(aws sts get-caller-identity --query 'Arn' --output text)
printf "  \033[32m✓\033[0m identity: %s\n" "$caller"

echo
echo "All tool checks passed."
