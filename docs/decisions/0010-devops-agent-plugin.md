# ADR 0010 - DevOps Agent Backstage plugin (genai-style chat)

**Status:** Accepted (2026-06-12). Supersedes the 2026-06-12 (earlier-same-day)
incidents-table revision of this same ADR, which itself superseded a
withdrawn EventBridge -> Lambda -> IncidentBinding-CRD pipeline.

## Context

Phase 5: surface AWS DevOps Agent capabilities for Fleet workloads inside
Backstage. We tried two prior shapes:

1. **Push pipeline** (CloudWatch / EventBridge -> incident-enricher Lambda
   -> IncidentBinding CRD -> catalog provider). Worked end-to-end but heavy
   infrastructure for a fundamentally read-and-show feature. Withdrawn.
2. **Incidents table** (SecurityHub-shape). Ported the awslabs SecurityHub
   pattern: backend reads `ListBacklogTasks` at request time and renders a
   table on an entity tab; "Start investigation" calls `CreateBacklogTask`.
   Worked, but treated the agent as a passive ticket store.

Neither shape used the agent the way the agent is designed to be used:
**conversationally**. AWS DevOps Agent's primary surface is interactive chat
backed by Journal records and Recommendations - the same way the
`awslabs/backstage-plugins-for-aws/plugins/genai` plugin treats Bedrock
agents. Aligning with that pattern also makes the plugin a natural candidate
for **publishing on the Backstage marketplace** (https://backstage.io/plugins/)
without divergence from the awslabs reference.

## Decision

**Replace the incidents-table tab with a genai-style chat tab.** Keep the
three-package shape (common / backend / frontend), keep the catalog-annotation
opt-in, and add **on-demand `CreateAgentSpace` provisioning** so operators
do not have to pre-create an agentSpace in the AWS console.

Three pillars (matching the awslabs `genai` plugin's design):

1. **Binding - Catalog annotation.** An entity opts into the chat tab via
   `aws.amazon.com/devops-agent-tags`. The Fleet entity provider stamps it
   automatically (`service=<name>,project=<namespace>`) so all Fleet
   workloads get the tab; hand-authored entities can opt in too. An optional
   `aws.amazon.com/devops-agent-space-id` annotation pins the chat to a
   specific pre-existing agentSpace (per-entity override).

2. **Render - Interactive chat.** The entity tab is `ChatContent.tsx`, a
   message-bubble UI with an input composer. Lifecycle:
   - On mount, `GET /api/devops-agent/agentspace?entityRef=...` resolves
     (or lazily provisions) the agentSpace.
   - "Start chat" -> `POST /chats` -> `CreateChat` against the agentSpace,
     scoped to the entity (entityRef + tags embedded in the chat title).
   - User input -> `POST /chats/:chatId/messages` -> `SendMessage`. **`SendMessage`
     returns an `AsyncIterable` event stream** (`responseCreated` ->
     `responseInProgress` -> `contentBlockStart/Delta/Stop`* ->
     `responseCompleted`), *not* a value to poll for. The backend drains the
     stream and assembles the reply from the content blocks, preferring the
     `final_response` block (a parallel `text` block streams the same answer;
     `context_usage` is JSON telemetry and `chat_title` is the auto-generated
     title - none of those are the reply body). The assembled reply returns
     inline on the same request (~30-60s round-trip), rendered with the chat
     title as an optional citation footer.
   - The chat id is persisted in `localStorage`. There is **no chat-transcript
     read API** (the SDK's `ListPendingMessages` is the agent's *inbound* queue,
     not the conversation), so a tab reload keeps the client-side view and the
     header links out to the agentSpace web app for the authoritative history.

3. **Provisioning - On-demand `CreateAgentSpace`.** Instead of requiring an
   `agentSpaceId` in `platform.yaml`, the backend resolves the agentSpace in
   this priority order:
   1. Per-entity `aws.amazon.com/devops-agent-space-id` annotation (override).
   2. Pinned `aws.devopsAgent.agentSpaceId` config value (operator opt-in).
   3. Fleet-default: `ListAgentSpaces` -> match by name `fleet-default`.
   4. Fall through to `CreateAgentSpace` and cache the id in-process.

   Single-flight guarded so concurrent first-loads don't race each other.

## Implementation

| Package | Module | Responsibility |
|---|---|---|
| `@internal/plugin-devops-agent-common` | `index.ts` | Annotation constants + `AgentSpaceInfo`, `ChatMessage`, `ChatSession`, `CreateChatResponse`, `SendMessageResponse`, `ListMessagesResponse` types |
| `@internal/plugin-devops-agent-backend` | `DevOpsAgentService` | `resolveAgentSpace`, `getOrCreateAgentSpace` (single-flight), `createChat`, `sendMessage` (drains the `SendMessage` event stream via `assembleReplyFromStream`), `listMessages` (no-op: no transcript API) |
| `@internal/plugin-devops-agent-backend` | `router.ts` | `GET /agentspace`, `POST /chats`, `POST/GET /chats/:chatId/messages` (catalog auth on every chat-bearing route) |
| `@internal/plugin-devops-agent` (frontend) | `ChatContent.tsx` | Genai-style chat UI: status badge, agentSpace deep link, message bubbles, optimistic echo, references footer, localStorage replay |
| `@internal/plugin-devops-agent` (frontend) | `plugin.tsx` | `EntityContentBlueprint` registers the tab at `/devops-agent` with annotation-presence filter |

The CDK Backstage Pod Identity role (`PlatformStack.addBackstageBootstrap`)
grants the aidevops action set required by the chat surface:
`ListAgentSpaces`, `CreateAgentSpace`, `GetAgentSpace`, `CreateChat`,
`SendMessage`, `ListChats`, `ListExecutions`, `ListJournalRecords`,
`Get/ListRecommendation*`, plus the optional `*BacklogTask` actions for
chat -> investigation escalation. (There is no `ListChatMessages`/`GetChat`
in the SDK - the reply lives in the `SendMessage` stream, and there is no
transcript read API.)

## Rationale

- **Right altitude.** Chat is the agent's primary surface. A conversational
  Backstage tab matches operator intuition ("ask the agent why my service is
  failing") and avoids reducing the agent to a ticket list.
- **Zero-touch provisioning.** Lazy `CreateAgentSpace` removes a manual
  AWS-console step from the platform-engineer onboarding path. Operators who
  want strict control still get a pin via `agentSpaceId`.
- **Marketplace-ready shape.** Mirroring awslabs `genai` (three packages,
  annotation-driven binding, request-time AWS API, no event pipeline)
  positions the plugin for publishing on backstage.io/plugins without
  Fleet-specific divergence.
- **No new infra.** Zero Lambda / CRD / EventBridge. The only AWS-side change
  is broader `aidevops:*` actions on the existing Backstage Pod Identity
  role (already granted when `developerPortal.enabled` &&
  `observability.devopsAgent.enabled`).

## Consequences

- **Graceful when unconfigured.** With `aws.devopsAgent.enabled=false` the
  backend returns `{configured: false}` and the chat tab shows
  "Not configured" with the platform.yaml hint.
- **agentSpace cache is in-process.** A Backstage pod restart triggers one
  extra `ListAgentSpaces` (idempotent, fast) on first chat load. No
  durable state needed.
- **Chat reply v1 is synchronous-blocking.** The backend drains the
  `SendMessage` event stream server-side and returns the assembled reply on
  the same HTTP request (~30-60s). It does *not* yet forward the stream to the
  browser as SSE, so the user sees "Agent is thinking..." then the full reply
  at once. Because the request stays open for the whole drain, the Backstage
  ALB ingress sets `idle_timeout.timeout_seconds=180` (the default 60s would
  sever a slow reply); the backend's own `REPLY_STREAM_TIMEOUT_MS` backstop is
  90s. Token-by-token SSE via `/chats/:id/stream` is a future PR.
- **No durable chat history.** The SDK has no transcript read API
  (`ListPendingMessages` is the agent's inbound queue), so `listMessages` is a
  no-op and a tab reload cannot replay past turns from the server. The
  client-side view + the agentSpace web-app deep link cover the gap.
- **No structured entity<->chat link.** The agent's `reference` field is
  validated against registered data-plane integrations; "backstage" is not
  one. We embed `entityRef` + tags in the chat title (and the agent picks
  them up as conversational context), same trade-off as the prior table-shape
  iteration.
- **Withdrawn surface removed.** `IncidentsContent.tsx` and the
  `/incidents` + `/investigations` routes are gone. Anyone bookmarking the
  old `/incidents` entity sub-path will get a 404; the catalog tab is now at
  `/devops-agent`.

## Future

- **Streaming replies** via `/chats/:chatId/stream` (SSE) using the SDK's
  streaming variant of SendMessage when stable.
- **Drawer for Recommendation / Journal detail** when the agent attaches
  references, so a developer can drill from the chat citation into the full
  Journal record without leaving Backstage.
- **Cross-entity chats** for project-scoped (System) entities, aggregating
  tags across child Components.
- **Marketplace publish.** Promote the three packages from `@internal/...` to
  scoped public names (`@aws/plugin-devops-agent-{common,backend,frontend}`)
  and submit to backstage.io/plugins. The shape already matches the awslabs
  publish template.
