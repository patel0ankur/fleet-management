# Hello Agent — Fleet Golden Path Sample

A minimal AI agent that demonstrates how to build, containerize, and deploy agents on the Fleet platform using Amazon Bedrock as the LLM backend.

## What This Agent Does

- Exposes a `/chat` REST endpoint
- Uses Claude (via Bedrock Converse API) as its reasoning brain
- Has two sample tools: `get_cluster_info` and `get_current_time`
- Demonstrates the full agentic loop (think → act → observe → respond)

## Architecture

```
User → POST /chat → Agent Pod (EKS) → Bedrock (us-east-1) → Response
                         │
                         └─ executes tools (get_cluster_info, get_current_time)
```

## Quick Start (Local)

### Prerequisites

- Docker
- AWS credentials with `bedrock:InvokeModel` permission in `us-east-1`
- Bedrock model access enabled for `anthropic.claude-3-haiku-20240307-v1:0`

### Run

```bash
cd samples/agents/hello-agent
docker compose up --build
```

### Test

```bash
# Simple question (no tools needed)
curl -s http://localhost:8080/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What is Kubernetes?"}' | jq .

# Triggers the get_current_time tool
curl -s http://localhost:8080/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What time is it right now?"}' | jq .

# Triggers the get_cluster_info tool
curl -s http://localhost:8080/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Tell me about the cluster you are running on"}' | jq .
```

### Expected Response

```json
{
  "reply": "The current UTC time is 2026-06-18T15:30:00+00:00.",
  "tool_calls": [
    {
      "tool": "get_current_time",
      "input": {},
      "output": "{\"utc\": \"2026-06-18T15:30:00.123456+00:00\"}"
    }
  ],
  "model": "anthropic.claude-3-haiku-20240307-v1:0",
  "duration_ms": 1234
}
```

## Deploy on Fleet (EKS)

### 1. Build and push the image

```bash
# Authenticate to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin <ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com

# Build and push
docker build -t <ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com/fleet/hello-agent:v0.1.0 .
docker push <ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com/fleet/hello-agent:v0.1.0
```

### 2. Deploy via the golden path (kro)

Edit `k8s/agent-deployment.yaml`, replace `{{ ECR_URI }}` with your ECR registry, then commit to the GitOps repo:

```bash
cp k8s/agent-deployment.yaml ../../../fleet-gitops/clusters/control/agents/hello-agent.yaml
# Commit and push — ArgoCD deploys it automatically
```

### 3. Deploy manually (without kro)

```bash
# Replace the image URI in the raw manifests
sed -i 's|REPLACE_WITH_ECR_URI|<ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com|' k8s/raw-manifests.yaml
kubectl apply -f k8s/raw-manifests.yaml
```

### 4. Create Pod Identity association

The agent needs Bedrock access. Create a Pod Identity association for the service account:

```bash
# Create IAM role (or use the one the platform provides)
aws eks create-pod-identity-association \
  --cluster-name fleet-control \
  --namespace agents \
  --service-account hello-agent \
  --role-arn arn:aws:iam::<ACCOUNT>:role/fleet-agent-bedrock-role
```

The role needs this policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0"
    }
  ]
}
```

## Build Your Own Agent

Use this as a starting point. To create your own agent:

1. **Add tools** — Extend the `TOOLS` list and `execute_tool()` function in `app/main.py`
2. **Change the model** — Set `MODEL_ID` env var (e.g. `anthropic.claude-3-5-sonnet-20241022-v2:0`)
3. **Add dependencies** — Update `app/requirements.txt`
4. **Adjust IAM** — If your tools call AWS APIs, add permissions to the Pod Identity role
5. **Deploy** — Follow the golden path above

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `AWS_REGION` | `us-east-1` | AWS region for Bedrock API calls |
| `MODEL_ID` | `anthropic.claude-3-haiku-20240307-v1:0` | Bedrock model identifier |
| `MAX_TOKENS` | `1024` | Maximum tokens per LLM response |
| `LOG_LEVEL` | `INFO` | Python logging level |

## Project Structure

```
hello-agent/
├── app/
│   ├── __init__.py
│   ├── main.py              # Agent code (FastAPI + Bedrock + tools)
│   └── requirements.txt     # Python dependencies
├── k8s/
│   ├── agent-deployment.yaml  # Fleet golden path CR (kro)
│   └── raw-manifests.yaml     # Expanded K8s resources (for reference)
├── Dockerfile               # Multi-stage production image
├── docker-compose.yaml      # Local testing
└── README.md
```
