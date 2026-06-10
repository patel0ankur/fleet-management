# Phase 1 Verification Runbook

Run after `fleetctl deploy` completes. All checks must pass.

## 0. Configure kubectl

```bash
aws eks update-kubeconfig \
  --region us-east-1 \
  --name $(aws cloudformation describe-stacks \
            --stack-name fleet-<name>-bootstrap \
            --region us-east-1 \
            --query "Stacks[0].Outputs[?OutputKey=='ClusterName'].OutputValue" \
            --output text)
```

## 1. EKS reachable

```bash
kubectl get nodes
```

**Expected:** all nodes `Ready`, both `system` and `platform` nodegroups present.

## 2. Capabilities are ACTIVE

```bash
CLUSTER=$(kubectl config current-context | awk -F/ '{print $2}')
for c in ack kro argocd; do
  aws eks describe-capability \
    --region us-east-1 \
    --cluster-name "$CLUSTER" \
    --capability-name fleet-<name>-$c \
    --query 'capability.{Name:capabilityName,Type:type,Status:status}' \
    --output table
done
```

**Expected:** all three show `Status: ACTIVE`. Newly created capabilities take a few minutes to transition from `CREATING`.

## 3. ACK can provision

```bash
kubectl api-resources | grep services.k8s.aws | head -5
```

**Expected:** rows for `bucket.s3.services.k8s.aws`, `dbinstance.rds.services.k8s.aws`, etc. Then smoke-test:

```bash
kubectl apply -f - <<'EOF'
apiVersion: s3.services.k8s.aws/v1alpha1
kind: Bucket
metadata:
  name: fleet-phase1-smoke
spec:
  name: fleet-phase1-smoke-$RANDOM
EOF

kubectl get bucket fleet-phase1-smoke -o yaml | grep -A2 conditions
aws s3 ls | grep fleet-phase1-smoke
```

**Expected:** `ACK.ResourceSynced=True`, bucket visible in `aws s3 ls`. Cleanup: `kubectl delete bucket fleet-phase1-smoke`.

## 4. kro is ready

```bash
kubectl get crd | grep kro.run
```

**Expected:** `resourcegraphdefinitions.kro.run` present. Phase 2 will create the first ResourceGraphDefinition.

## 5. Argo CD hosted UI + bootstrap Application

```bash
URL=$(aws cloudformation describe-stacks \
        --stack-name fleet-<name>-platform \
        --region us-east-1 \
        --query "Stacks[0].Outputs[?OutputKey=='ArgoCdServerUrl'].OutputValue" \
        --output text)
echo "Open: $URL"
```

**Expected:** Argo UI loads, redirects to AWS Identity Center for sign-in. Members of the IdC group set in `spec.identity.idc.adminGroupId` get ADMIN role.

```bash
kubectl -n argocd get application fleet-bootstrap \
  -o jsonpath='{.status.sync.status}/{.status.health.status}{"\n"}'
```

**Expected:** `Synced/Healthy` (or `Synced/Progressing` briefly while it walks child resources). The bootstrap Application is created by `PlatformStack` and points at `<gitops.repoUrl>/<branch>/<pathPrefix>`. Anything you commit under that path will be applied within ~3 minutes.

If the status shows `Unknown` with `cluster ... is disabled`, the in-cluster destination Secret is missing — see ADR 0006 and the troubleshooting section.

## 6. Secrets Store CSI Driver + ASCP working

```bash
kubectl -n kube-system get pods -l app=secrets-store-csi-driver
kubectl -n kube-system get pods -l app=secrets-store-csi-driver-provider-aws
```

**Expected:** one driver pod and one provider pod **per node**, all `Running`.

End-to-end mount test (auth uses Pod Identity on a per-workload SA):

```bash
# 1. Put a value in Secrets Manager
aws secretsmanager create-secret \
  --region us-east-1 \
  --name /fleet/smoke \
  --secret-string '{"greeting":"hello-fleet"}'

# 2. Create an IAM role the workload pod will assume via Pod Identity
SECRET_ARN=$(aws secretsmanager describe-secret --region us-east-1 --secret-id /fleet/smoke --query ARN --output text)
aws iam create-role --role-name fleet-csi-smoke --assume-role-policy-document '{
  "Version":"2012-10-17",
  "Statement":[{"Effect":"Allow","Principal":{"Service":"pods.eks.amazonaws.com"},"Action":["sts:AssumeRole","sts:TagSession"]}]}'
aws iam put-role-policy --role-name fleet-csi-smoke --policy-name read --policy-document "{
  \"Version\":\"2012-10-17\",
  \"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"secretsmanager:GetSecretValue\",\"secretsmanager:DescribeSecret\"],\"Resource\":\"$SECRET_ARN\"}]}"

aws eks create-pod-identity-association --region us-east-1 \
  --cluster-name fleet-control \
  --namespace default \
  --service-account fleet-csi-smoke \
  --role-arn arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):role/fleet-csi-smoke

# 3. Apply the SecretProviderClass + a smoke pod
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: ServiceAccount
metadata: { name: fleet-csi-smoke, namespace: default }
---
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata: { name: fleet-csi-smoke, namespace: default }
spec:
  provider: aws
  parameters:
    # Tell ASCP to authenticate via EKS Pod Identity (vs the default IRSA path).
    usePodIdentity: "true"
    region: us-east-1
    objects: |
      - objectName: "/fleet/smoke"
        objectType: "secretsmanager"
---
apiVersion: v1
kind: Pod
metadata: { name: fleet-csi-smoke, namespace: default }
spec:
  serviceAccountName: fleet-csi-smoke
  containers:
    - name: app
      image: public.ecr.aws/docker/library/busybox:1.36
      # ASCP rewrites slashes in objectName to underscores in the mount filename.
      command: ["sh", "-c", "cat /mnt/secrets-store/_fleet_smoke && sleep 600"]
      volumeMounts:
        - name: secrets
          mountPath: /mnt/secrets-store
          readOnly: true
  volumes:
    - name: secrets
      csi:
        driver: secrets-store.csi.k8s.io
        readOnly: true
        volumeAttributes:
          secretProviderClass: fleet-csi-smoke
EOF

# 4. Verify
sleep 20
kubectl logs fleet-csi-smoke -n default
```

**Expected:** logs print `{"greeting":"hello-fleet"}`.

Cleanup:
```bash
kubectl delete pod fleet-csi-smoke -n default
kubectl delete secretproviderclass fleet-csi-smoke -n default
kubectl delete sa fleet-csi-smoke -n default
aws eks delete-pod-identity-association --region us-east-1 --cluster-name fleet-control \
  --association-id $(aws eks list-pod-identity-associations --region us-east-1 --cluster-name fleet-control \
                     --service-account fleet-csi-smoke --namespace default \
                     --query 'associations[0].associationId' --output text)
aws iam delete-role-policy --role-name fleet-csi-smoke --policy-name read
aws iam delete-role --role-name fleet-csi-smoke
aws secretsmanager delete-secret --region us-east-1 --secret-id /fleet/smoke --force-delete-without-recovery
```

## If any of these fail

- **Capability stuck in `CREATING`** — check `aws eks describe-capability`'s `statusReason`. Usually IAM trust policy or missing IdC instance for ARGOCD.
- **ACK CRs apply but never reconcile** — check the ACK Capability Role permissions. Phase 1 uses `AdministratorAccess`; if it was tightened too far, `kubectl describe` on the CR shows the AWS API error.
- **Argo CD UI redirect loop** — the IdC group ID was wrong, or the user signing in isn't in that group.
- **CSI mount fails with `MountVolume.SetUp failed`** - `kubectl describe pod` and look at events. Common causes:
  - `An IAM role must be associated with service account ...` -> the SecretProviderClass is missing `usePodIdentity: "true"` (ASCP defaults to IRSA).
  - `The token included in the request has no service account role association for it` -> Pod Identity association missing or wrong namespace/SA. Verify with `aws eks list-pod-identity-associations --service-account <name> --namespace <ns>`.
  - `AccessDeniedException: ... GetSecretValue` -> the IAM role exists but lacks `secretsmanager:GetSecretValue` on the secret's ARN.
