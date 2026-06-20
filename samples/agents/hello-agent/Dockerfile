# Hello Agent — reference image for the Fleet agentic-service golden path.
# Multi-stage: build deps into a venv, copy into a slim runtime, run non-root.
FROM python:3.12-slim AS build
WORKDIR /app
COPY app/requirements.txt .
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

FROM python:3.12-slim AS runtime
# Non-root user (the agentic-service RGD does not set a podSecurityContext, so
# the image must run as non-root on its own).
RUN useradd --create-home --uid 10001 agent
WORKDIR /app
COPY --from=build /opt/venv /opt/venv
COPY app/ ./app/
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    AWS_REGION=us-east-1 \
    MODEL_ID=us.anthropic.claude-opus-4-8 \
    MAX_TOKENS=1024
USER agent
EXPOSE 8080
# /health is the liveness endpoint defined in app/main.py.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health').status==200 else 1)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
