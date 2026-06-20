"""
Hello Agent — A minimal AI agent demonstrating Fleet's golden path.

This agent:
  1. Exposes a REST API (FastAPI)
  2. Receives user messages
  3. Uses Amazon Bedrock (Claude) as its LLM brain
  4. Has simple tools (get_cluster_info, get_current_time) to show the agent loop
  5. Returns the response to the caller

It serves as the reference implementation for teams building agents on the
Fleet platform. Deploy it via the AgentDeployment kro abstraction.
"""

import json
import logging
import os
from datetime import datetime, timezone

import boto3
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Configuration (injected via environment — see K8s manifests)
# ---------------------------------------------------------------------------

AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
MODEL_ID = os.getenv("MODEL_ID", "anthropic.claude-3-haiku-20240307-v1:0")
MAX_TOKENS = int(os.getenv("MAX_TOKENS", "1024"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")

logging.basicConfig(level=LOG_LEVEL, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("hello-agent")

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Hello Agent",
    description="Sample AI agent running on Fleet's golden path",
    version="0.1.0",
)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    message: str


class ChatResponse(BaseModel):
    reply: str
    tool_calls: list[dict] = []
    model: str
    duration_ms: int


# ---------------------------------------------------------------------------
# Tools — these are the "hands" of the agent
# ---------------------------------------------------------------------------

# Bedrock Converse toolSpec shape: name + description + inputSchema.json
# (NOT the Anthropic Messages-API `input_schema` shape — Converse rejects it).
TOOLS = [
    {
        "name": "get_cluster_info",
        "description": "Returns basic information about the Kubernetes cluster this agent is running on. Use this when the user asks about the cluster, environment, or where the agent is deployed.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
    {
        "name": "get_current_time",
        "description": "Returns the current UTC time. Use this when the user asks what time it is.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
]


def execute_tool(tool_name: str, tool_input: dict) -> str:
    """Execute a tool and return the result as a string."""
    if tool_name == "get_cluster_info":
        return json.dumps({
            "cluster": os.getenv("CLUSTER_NAME", "unknown"),
            "namespace": os.getenv("POD_NAMESPACE", "unknown"),
            "pod": os.getenv("POD_NAME", "unknown"),
            "node": os.getenv("NODE_NAME", "unknown"),
            "region": AWS_REGION,
            "model": MODEL_ID,
        })
    elif tool_name == "get_current_time":
        return json.dumps({
            "utc": datetime.now(timezone.utc).isoformat(),
        })
    else:
        return json.dumps({"error": f"Unknown tool: {tool_name}"})


# ---------------------------------------------------------------------------
# Bedrock client
# ---------------------------------------------------------------------------

def get_bedrock_client():
    """Create Bedrock Runtime client. Uses Pod Identity on EKS (no keys needed)."""
    return boto3.client("bedrock-runtime", region_name=AWS_REGION)


# ---------------------------------------------------------------------------
# Agent loop — the core pattern
# ---------------------------------------------------------------------------

def run_agent_loop(user_message: str) -> tuple[str, list[dict]]:
    """
    The agentic loop:
      1. Send user message + tool definitions to the LLM
      2. If LLM wants to use a tool -> execute it, send result back
      3. Repeat until LLM produces a final text response
    """
    client = get_bedrock_client()
    messages = [{"role": "user", "content": [{"text": user_message}]}]
    tool_calls_log: list[dict] = []

    system_prompt = (
        "You are Hello Agent, a helpful assistant running on a Fleet-managed "
        "Kubernetes cluster. You demonstrate the golden path for AI agents on "
        "the Fleet platform. Be concise and helpful. Use your tools when relevant."
    )

    # Agent loop — max 5 iterations to prevent runaway
    for iteration in range(5):
        logger.info(f"Agent loop iteration {iteration + 1}")

        response = client.converse(
            modelId=MODEL_ID,
            system=[{"text": system_prompt}],
            messages=messages,
            toolConfig={"tools": [{"toolSpec": t} for t in TOOLS]},
            inferenceConfig={"maxTokens": MAX_TOKENS},
        )

        output = response["output"]["message"]
        stop_reason = response["stopReason"]
        messages.append(output)

        # If the model is done (no tool use), extract final text
        if stop_reason == "end_turn":
            final_text = ""
            for block in output["content"]:
                if "text" in block:
                    final_text += block["text"]
            return final_text, tool_calls_log

        # If the model wants to use a tool
        if stop_reason == "tool_use":
            tool_results = []
            for block in output["content"]:
                if "toolUse" in block:
                    tool_use = block["toolUse"]
                    tool_name = tool_use["name"]
                    tool_input = tool_use.get("input", {})
                    tool_use_id = tool_use["toolUseId"]

                    logger.info(f"Tool call: {tool_name}({tool_input})")
                    result = execute_tool(tool_name, tool_input)
                    tool_calls_log.append({
                        "tool": tool_name,
                        "input": tool_input,
                        "output": result,
                    })

                    tool_results.append({
                        "toolResult": {
                            "toolUseId": tool_use_id,
                            "content": [{"text": result}],
                        }
                    })

            messages.append({"role": "user", "content": tool_results})

    return "I reached my maximum reasoning steps. Please try a simpler request.", tool_calls_log


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """Send a message to the agent and get a response."""
    logger.info(f"Received message: {request.message[:100]}")
    start = datetime.now(timezone.utc)

    try:
        reply, tool_calls = run_agent_loop(request.message)
    except Exception as e:
        logger.error(f"Agent loop failed: {e}")
        raise HTTPException(status_code=500, detail=f"Agent error: {str(e)}")

    duration_ms = int((datetime.now(timezone.utc) - start).total_seconds() * 1000)
    logger.info(f"Response generated in {duration_ms}ms, tool_calls={len(tool_calls)}")

    return ChatResponse(
        reply=reply,
        tool_calls=tool_calls,
        model=MODEL_ID,
        duration_ms=duration_ms,
    )


CHAT_UI = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hello Agent</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
           background: #0f1117; color: #e6e6e6; height: 100vh; display: flex; flex-direction: column; }
    header { padding: 14px 18px; border-bottom: 1px solid #262b36; font-weight: 600;
             display: flex; align-items: center; gap: 10px; }
    header small { font-weight: 400; color: #8a93a6; }
    #log { flex: 1; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 12px; }
    .msg { max-width: 760px; padding: 10px 14px; border-radius: 12px; white-space: pre-wrap;
           line-height: 1.45; }
    .user { align-self: flex-end; background: #2563eb; color: #fff; border-bottom-right-radius: 3px; }
    .agent { align-self: flex-start; background: #1b212e; border: 1px solid #2a3142;
             border-bottom-left-radius: 3px; }
    .tools { align-self: flex-start; font-size: 12px; color: #8a93a6; font-family: ui-monospace, monospace; }
    .meta { font-size: 11px; color: #6b7488; margin-top: 4px; }
    form { display: flex; gap: 8px; padding: 14px 18px; border-top: 1px solid #262b36; }
    #q { flex: 1; padding: 11px 14px; border-radius: 10px; border: 1px solid #2a3142;
         background: #11151e; color: #e6e6e6; font-size: 15px; }
    button { padding: 11px 18px; border: 0; border-radius: 10px; background: #2563eb; color: #fff;
             font-size: 15px; cursor: pointer; }
    button:disabled { opacity: .5; cursor: default; }
  </style>
</head>
<body>
  <header>Hello Agent <small id="model"></small></header>
  <div id="log"></div>
  <form id="f">
    <input id="q" autocomplete="off" placeholder="Ask the agent… (e.g. what cluster are you on?)" autofocus>
    <button id="send" type="submit">Send</button>
  </form>
  <script>
    const log = document.getElementById('log'), q = document.getElementById('q'),
          f = document.getElementById('f'), send = document.getElementById('send');
    function add(cls, text) {
      const d = document.createElement('div'); d.className = 'msg ' + cls; d.textContent = text;
      log.appendChild(d); log.scrollTop = log.scrollHeight; return d;
    }
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const message = q.value.trim(); if (!message) return;
      add('user', message); q.value = ''; send.disabled = true;
      const thinking = add('agent', '…');
      try {
        const r = await fetch('/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message })
        });
        const data = await r.json();
        if (!r.ok) { thinking.textContent = 'Error: ' + (data.detail || r.status); return; }
        thinking.textContent = data.reply;
        if (data.tool_calls && data.tool_calls.length) {
          add('tools', '🔧 ' + data.tool_calls.map(t => t.tool).join(', '));
        }
        const m = document.createElement('div'); m.className = 'meta';
        m.textContent = data.model + ' · ' + data.duration_ms + 'ms';
        thinking.appendChild(m);
        document.getElementById('model').textContent = '· ' + data.model;
      } catch (err) {
        thinking.textContent = 'Request failed: ' + err;
      } finally {
        send.disabled = false; q.focus();
      }
    });
  </script>
</body>
</html>"""


@app.get("/", response_class=HTMLResponse)
async def chat_ui():
    """Minimal browser chat UI — POSTs to /chat. Visit the base URL in a browser."""
    return CHAT_UI


@app.get("/health")
async def health():
    """Liveness probe."""
    return {"status": "healthy"}


@app.get("/ready")
async def ready():
    """Readiness probe — verifies AWS credentials are locatable.

    On EKS the Pod Identity webhook injects credentials into the pod at
    *admission*. If a pod is admitted before its PodIdentityAssociation has
    propagated (a race kro's readyWhen gate narrows but can't fully close —
    the CR can report ACK.ResourceSynced before the webhook sees it), the pod
    starts with NO credentials and boto3 raises NoCredentialsError on every
    Bedrock call ("Unable to locate credentials"). Such a pod can't recover in
    place (injection is admission-only), so we fail readiness: Kubernetes pulls
    it from the Service endpoints and chat traffic routes only to healthy pods.

    Uses STS get_caller_identity — cheap and free (no Bedrock tokens), and it
    tests the actual dependency (credentials), not model access. Cheap enough
    to run on the default ~10s readiness cadence.
    """
    try:
        sts = boto3.client("sts", region_name=AWS_REGION)
        ident = sts.get_caller_identity()
        return {"status": "ready", "model": MODEL_ID, "arn": ident["Arn"]}
    except Exception as e:
        logger.warning(f"Readiness failed (credentials not available yet?): {e}")
        raise HTTPException(status_code=503, detail=f"Not ready: {str(e)}")
