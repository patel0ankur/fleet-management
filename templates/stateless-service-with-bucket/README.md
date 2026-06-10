# StatelessServiceWithBucket

The first golden path. Provisions everything a typical "service that reads/writes an S3 bucket" needs:

| Resource | Purpose |
|---|---|
| `s3.services.k8s.aws/Bucket` | The S3 bucket the service uses |
| `iam.services.k8s.aws/Policy` | Least-privilege policy on the bucket |
| `iam.services.k8s.aws/Role` | IAM role assumed by the workload, trusted by `pods.eks.amazonaws.com` |
| `eks.services.k8s.aws/PodIdentityAssociation` | Binds the K8s SA to the IAM role |
| `v1/ServiceAccount` | The pod's identity |
| `apps/v1/Deployment` | The workload, with `BUCKET_NAME` injected as an env var |
| `v1/Service` | ClusterIP fronting the deployment |

## Usage

Create a `Deployment` CR in your project's namespace:

```yaml
apiVersion: platform.{{ ORG }}/v1alpha1
kind: Deployment
metadata:
  name: hello
  namespace: smoke-team
spec:
  template: stateless-service-with-bucket.kro.run
  values:
    name: hello
    image: public.ecr.aws/nginx/nginx:1.27
    replicas: 1
    bucketSuffix: smoke
    costCenter: "0000-smoke"
```

The bucket name is `<name>-<bucketSuffix>-<namespace>` to keep it globally unique within an account/region.

## Inputs

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | string | required | Workload name; used as Deployment name + SA name |
| `image` | string | required | Container image |
| `replicas` | int | 2 | |
| `containerPort` | int | 8080 | |
| `bucketSuffix` | string | `""` | Appended to bucket name |
| `costCenter` | string | `""` | AWS resource tag |

## Outputs (status)

- `bucketArn`
- `serviceAccount`
- `podIdentityAssociationName`

## Limitations (Phase 2)

- Cluster name is templated at render time (`{{ CLUSTER_NAME }}`); Phase 4 introduces an `Environment` CR to make this dynamic.
- ACK reconciles the bucket asynchronously; the workload pod may CrashLoopBackOff briefly until the Pod Identity association propagates. Add a longer `livenessProbe.initialDelaySeconds` if the image hits S3 on startup.
