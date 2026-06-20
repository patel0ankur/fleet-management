# Hello Agent — Implementation Progress

## Goal

Build a sample AI agent that demonstrates Fleet's **golden path** for deploying
agentic workloads on EKS with Bedrock. This ships in the public repo so end
users can clone it, customize the tools, and deploy their own agents using the
same platform abstractions.

## Architecture

```
End User ──► ALB ──► Agent Service (EKS pod) ──► Bedrock (Claude, us-east-1)
                            │
                            └── tools (get_cluster_info, get_current_time)
```

- Agent runs as a stateless FastAPI container on EKS
- LLM brain is Amazon Bedrock (Converse API) — no GPUs needed on the pod
- Auth to Bedrock via Pod Identity (IAM, no API keys)
- Exposed via K8s Service + ALB Ingress (AWS LB Controller already in Fleet)

## Completed

- [x] **Python application** — `app/main.py`
  - FastAPI with `/chat`, `/health`, `/ready` endpoints
  - Bedrock Converse API agent loop (max 5 iterations)
  - Two sample tools: `get_cluster_info`, `get_current_time`
  - Config via environment variables (MODEL_ID, AWS_REGION, MAX_TOKENS)
  - Default region: `us-east-1`
- [x] **Requirements** — `app/requirements.txt` (fastapi, uvicorn, boto3, pydantic)
- [x] **Dockerfile** — multi-stage build, non-root user, port 8080, health check
- [x] **.dockerignore**

## Remaining

- [ ] **K8s manifests** (`k8s/` directory)
  - `AgentDeployment` platform CR (follows `samples/projects/smoke-team` conventions)
  - kro `AgentGraph` instance that fans out into:
    - Deployment (pod spec, resource limits, env vars)
    - Service (ClusterIP on port 80 → 8080)
    - ServiceAccount (for Pod Identity)
    - NetworkPolicy (sandbox — egress only to Bedrock endpoint + DNS)
    - KEDA ScaledObject (optional, scale on request queue)
  - IAM policy snippet (bedrock:InvokeModel, scoped to the model)

- [ ] **README.md** for this sample
  - How to run locally (docker-compose with localstack or real AWS creds)
  - How to deploy on Fleet (apply the CR to gitops repo)
  - How to customize (add your own tools, change the model)
  - How to test (`curl` examples)

- [ ] **docker-compose.yaml** for local testing
  - Agent container + environment variables
  - Instructions for passing AWS credentials for local Bedrock access

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Region | us-east-1 | All Fleet infra in us-east-1 |
| Model | Claude 3 Haiku | Cheapest/fastest for demo; users swap via env var |
| Framework | FastAPI | Lightweight, async, good for reference code |
| Auth | Pod Identity | Fleet standard — no secrets to rotate |
| Port | 8080 | Fleet convention (matches Backstage, other workloads) |
| Agent loop cap | 5 iterations | Prevents runaway token spend |

## File Structure (final)

```
samples/agents/hello-agent/
├── app/
│   ├── __init__.py
│   ├── main.py              ✅ done
│   └── requirements.txt     ✅ done
├── k8s/
│   ├── agent-deployment.yaml    ← TODO
│   └── iam-policy.json          ← TODO
├── Dockerfile               ✅ done
├── .dockerignore            ✅ done
├── docker-compose.yaml          ← TODO
├── README.md                    ← TODO
└── TODO.md                  ✅ this file
```

## Resume Instructions

Pick up from task #3: "Create the K8s manifests (kro instance + platform CR)
following Fleet conventions." Reference `samples/projects/smoke-team/` for the
CR pattern and `templates/` for kro ResourceGroup structure.
