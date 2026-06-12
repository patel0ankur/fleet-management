# Fleet incident-enricher Lambda image (Node 22 on the AWS Lambda base).
FROM public.ecr.aws/lambda/nodejs:22

# Deps first for layer caching.
COPY package.json ${LAMBDA_TASK_ROOT}/
RUN npm install --omit=dev --no-audit --no-fund

COPY src/ ${LAMBDA_TASK_ROOT}/src/

# index.handler dispatches both the EventBridge enricher and the scheduled poller.
CMD [ "src/index.handler" ]
