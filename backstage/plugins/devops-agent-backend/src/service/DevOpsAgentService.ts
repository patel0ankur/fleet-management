import {
  DevOpsAgentClient,
  CreateAgentSpaceCommand,
  ListAgentSpacesCommand,
  CreateChatCommand,
  SendMessageCommand,
} from '@aws-sdk/client-devops-agent';
import { LoggerService } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import {
  AgentSpaceInfo,
  ChatMessage,
  ChatSession,
  CreateChatResponse,
  ListMessagesResponse,
  SendMessageResponse,
} from '@internal/plugin-devops-agent-common';

/**
 * DevOps Agent service. Phase 5 redesign: interactive chat surface modeled on
 * awslabs/backstage-plugins-for-aws/plugins/genai, plus on-demand
 * provisioning of the agentSpace via CreateAgentSpace.
 *
 * SDK contract notes (so you don't repeat the discovery I had to do):
 *
 *   CreateAgentSpace
 *     in:  { name, description?, locale?, kmsKeyArn?, clientToken?, tags? }
 *     out: { agentSpace: { agentSpaceId, name, ... } }
 *
 *   ListAgentSpaces
 *     in:  { nextToken? }
 *     out: { agentSpaces: AgentSpace[], nextToken? }     // each has agentSpaceId + name
 *
 *   CreateChat
 *     in:  { agentSpaceId }                               // NO title, NO initialMessage
 *     out: { executionId, createdAt }                     // chat session id is "executionId"
 *
 *   SendMessage  (THE reply lives here - it is a STREAM, not a poll target)
 *     in:  { agentSpaceId, executionId, content, context?, assetIds? }
 *            (userId is DEPRECATED/ignored since 2026-04-15 - the service
 *             resolves identity from the authenticated session; do NOT send it)
 *     out: { events: AsyncIterable<SendMessageEvents> }
 *           Lifecycle: responseCreated -> responseInProgress ->
 *             (contentBlockStart / contentBlockDelta / contentBlockStop)* ->
 *             responseCompleted | responseFailed   (+ heartbeat, summary).
 *           The assistant reply is assembled by iterating the stream and
 *           concatenating contentBlockDelta.delta.textDelta.text, grouped by
 *           block index. Each block has a `type` from contentBlockStart:
 *             - "final_response" : the canonical answer (PREFER this)
 *             - "text"           : same answer streamed pre-finalization (DUPE)
 *             - "context_usage"  : JSON telemetry (skip)
 *             - "chat_title"     : auto-generated chat title (not the reply)
 *           So we keep final_response if present, else fall back to text
 *           blocks; we never concatenate both (that double-printed the reply).
 *           A full round-trip is synchronous-ish (~30-60s) and ends at
 *           responseCompleted, so we return the reply inline - no second API.
 *
 *   ListPendingMessages was REMOVED: it returns messages queued FOR the agent
 *   to consume, not the chat transcript - it was always empty for us, which is
 *   why the chat looked silent. The reply is in the SendMessage stream above.
 *
 * Provisioning model:
 *   - resolveAgentSpace() picks an agentSpace via:
 *       1. Per-entity annotation override
 *       2. Pinned config value
 *       3. ListAgentSpaces -> match by name -> else CreateAgentSpace
 *   - Single-flight guarded so concurrent first-loads don't double-create.
 *   - In-process cache; pod restart triggers one extra ListAgentSpaces.
 *
 * AWS credentials come from the default chain - in our cluster that's the
 * Backstage pod's EKS Pod Identity role (PlatformStack grants `aidevops:*`
 * actions when developerPortal + observability.devopsAgent are enabled).
 */
export class DevOpsAgentService {
  private readonly client?: DevOpsAgentClient;
  private readonly region: string;
  /** Pinned agentSpace id from config, if any. Bypasses ListAgentSpaces. */
  private readonly pinnedAgentSpaceId?: string;
  /** Display name used for the Fleet-default agentSpace. */
  private readonly fleetAgentSpaceName: string;
  private readonly logger?: LoggerService;

  /** In-process cache of the resolved Fleet-default agentSpace id. */
  private cachedAgentSpaceId?: string;
  /** Single-flight guard for getOrCreateAgentSpace. */
  private resolveInFlight?: Promise<string>;

  /**
   * Hard ceiling on how long we drain one SendMessage stream before giving up
   * on the reply. A normal round-trip completes (responseCompleted) in
   * ~30-60s; this is the backstop so a stuck stream can't hang the request.
   */
  private static readonly REPLY_STREAM_TIMEOUT_MS = 90_000;

  private constructor(opts: {
    region: string;
    pinnedAgentSpaceId?: string;
    fleetAgentSpaceName: string;
    enabled: boolean;
    logger?: LoggerService;
  }) {
    this.region = opts.region;
    this.pinnedAgentSpaceId = opts.pinnedAgentSpaceId || undefined;
    this.fleetAgentSpaceName = opts.fleetAgentSpaceName;
    this.logger = opts.logger;
    this.client = opts.enabled
      ? new DevOpsAgentClient({ region: opts.region })
      : undefined;
  }

  static fromConfig(config: Config, opts: { logger: LoggerService }) {
    const conf = config.getOptionalConfig('aws.devopsAgent');
    // Use getOptional (untyped) + coerce, NOT getOptionalString: Backstage's
    // config reader throws "got empty-string, wanted string" on an empty
    // value, and the agentSpaceId is intentionally empty in the lazy-create
    // model.
    const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
    const region =
      asStr(conf?.getOptional('region')) ||
      asStr(config.getOptional('aws.region')) ||
      'us-east-1';
    const pinnedAgentSpaceId = asStr(conf?.getOptional('agentSpaceId'));
    const enabledFromConfig = conf?.getOptional('enabled');
    // Plugin "enabled" defaults true so chat-on-first-load works in dev with
    // implicit AWS creds; flip false to disable explicitly.
    const enabled = enabledFromConfig === false ? false : true;
    const fleetAgentSpaceName =
      asStr(conf?.getOptional('agentSpaceName')) || 'fleet-default';
    return new DevOpsAgentService({
      region,
      pinnedAgentSpaceId,
      fleetAgentSpaceName,
      enabled,
      logger: opts.logger,
    });
  }

  get configured(): boolean {
    return !!this.client;
  }

  /** Browser link to the DevOps Agent web app for an agentSpace. */
  private appBaseFor(agentSpaceId: string): string {
    return `https://${agentSpaceId}.aidevops.global.app.aws/home`;
  }

  /**
   * Resolve the agentSpace id for a given (optional) entity-level override.
   * Order of precedence:
   *   1. Per-entity annotation `aws.amazon.com/devops-agent-space-id`
   *   2. Pinned config value (`aws.devopsAgent.agentSpaceId`)
   *   3. Fleet-default: ListAgentSpaces -> match by name -> else CreateAgentSpace
   */
  async resolveAgentSpace(opts: {
    entityAgentSpaceId?: string;
  }): Promise<AgentSpaceInfo> {
    if (!this.client) {
      return {
        status: 'NOT_CONFIGURED',
        message: 'DevOps Agent plugin disabled (set aws.devopsAgent.enabled=true)',
      };
    }
    if (opts.entityAgentSpaceId) {
      return {
        status: 'READY',
        agentSpaceId: opts.entityAgentSpaceId,
        region: this.region,
        url: this.appBaseFor(opts.entityAgentSpaceId),
      };
    }
    if (this.pinnedAgentSpaceId) {
      return {
        status: 'READY',
        agentSpaceId: this.pinnedAgentSpaceId,
        region: this.region,
        url: this.appBaseFor(this.pinnedAgentSpaceId),
      };
    }
    try {
      const id = await this.getOrCreateAgentSpace();
      return {
        status: 'READY',
        agentSpaceId: id,
        region: this.region,
        url: this.appBaseFor(id),
      };
    } catch (e: any) {
      this.logger?.error(`devops-agent: resolveAgentSpace failed: ${e?.message ?? e}`);
      return {
        status: 'ERROR',
        region: this.region,
        message: e?.message ?? String(e),
      };
    }
  }

  /**
   * Returns the Fleet-default agentSpace id, creating it on first call.
   * In-process cached + single-flight.
   */
  private async getOrCreateAgentSpace(): Promise<string> {
    if (this.cachedAgentSpaceId) return this.cachedAgentSpaceId;
    if (this.resolveInFlight) return this.resolveInFlight;
    this.resolveInFlight = (async () => {
      const existing = await this.findAgentSpaceByName(this.fleetAgentSpaceName);
      if (existing) {
        this.logger?.info(
          `devops-agent: reusing agentSpace "${this.fleetAgentSpaceName}" (${existing})`,
        );
        this.cachedAgentSpaceId = existing;
        return existing;
      }
      const created = await this.createAgentSpace(this.fleetAgentSpaceName);
      this.logger?.info(
        `devops-agent: created agentSpace "${this.fleetAgentSpaceName}" (${created})`,
      );
      this.cachedAgentSpaceId = created;
      return created;
    })();
    try {
      return await this.resolveInFlight;
    } finally {
      this.resolveInFlight = undefined;
    }
  }

  /** Page through ListAgentSpaces and return the id whose name matches. */
  private async findAgentSpaceByName(name: string): Promise<string | undefined> {
    if (!this.client) return undefined;
    let nextToken: string | undefined;
    do {
      const res: any = await this.client.send(
        new ListAgentSpacesCommand({ nextToken } as any),
      );
      const spaces: any[] = res?.agentSpaces ?? [];
      for (const s of spaces) {
        if (s?.name === name && s?.agentSpaceId) {
          return s.agentSpaceId as string;
        }
      }
      nextToken = res?.nextToken;
    } while (nextToken);
    return undefined;
  }

  /** Provision a new agentSpace and return its id. */
  private async createAgentSpace(name: string): Promise<string> {
    if (!this.client) throw new Error('DevOps Agent client not configured');
    const res: any = await this.client.send(
      new CreateAgentSpaceCommand({
        name,
        description: 'Fleet-managed DevOps Agent space (auto-provisioned)',
        // clientToken makes CreateAgentSpace idempotent across pod restarts:
        // a second call with the same name+token just returns the existing id.
        clientToken: `fleet-${name}`,
      } as any),
    );
    const id = res?.agentSpace?.agentSpaceId;
    if (!id) {
      throw new Error('CreateAgentSpace returned no agentSpace.agentSpaceId');
    }
    return id as string;
  }

  // --------------------------------------------------------------------------
  // Chat surface (genai-style)
  // --------------------------------------------------------------------------

  /**
   * Open a new chat (chat execution) against the resolved agentSpace, scoped
   * to the given entity. The SDK's CreateChat takes only an agentSpaceId -
   * the entity binding is informational only on our side, embedded in our
   * server-generated welcome message.
   */
  async createChat(opts: {
    entityRef: string;
    tags: string;
    entityAgentSpaceId?: string;
    initialMessage?: string;
  }): Promise<CreateChatResponse> {
    if (!this.client) throw new Error('DevOps Agent not configured');
    const space = await this.resolveAgentSpace({
      entityAgentSpaceId: opts.entityAgentSpaceId,
    });
    if (space.status !== 'READY' || !space.agentSpaceId) {
      throw new Error(space.message ?? 'agentSpace not ready');
    }
    const res: any = await this.client.send(
      new CreateChatCommand({
        agentSpaceId: space.agentSpaceId,
      } as any),
    );
    const executionId: string | undefined = res?.executionId;
    if (!executionId) {
      throw new Error('CreateChat returned no executionId');
    }

    const chat: ChatSession = {
      executionId,
      agentSpaceId: space.agentSpaceId,
      entityRef: opts.entityRef,
      createdAt: this.toIso(res?.createdAt),
    };

    // The SDK has no concept of a "welcome message" - generate a synthetic
    // local one that grounds the user in what they're chatting about. It is
    // NOT sent to the agent; if the user has an initialMessage to actually
    // send to the agent, the frontend's first SendMessage call carries it.
    const welcome: ChatMessage = {
      id: `welcome-${executionId}`,
      role: 'system',
      content:
        `New chat for ${opts.entityRef}. ` +
        `Tags: ${opts.tags}. Ask the agent about logs, alarms, ` +
        `recent deployments, or recommendations.`,
      createdAt: chat.createdAt ?? new Date().toISOString(),
    };

    return { chat, welcome };
  }

  /**
   * Send a message in an existing chat and return the user echo + the agent's
   * reply. SendMessage returns an AsyncIterable event stream; we drain it,
   * assemble the assistant reply from the content-block deltas, and return it
   * inline. A normal round-trip completes in ~30-60s (responseCompleted);
   * REPLY_STREAM_TIMEOUT_MS is the backstop. We never poll a second API - the
   * reply is entirely in this stream.
   */
  async sendMessage(opts: {
    executionId: string;
    agentSpaceId: string;
    content: string;
  }): Promise<SendMessageResponse> {
    if (!this.client) throw new Error('DevOps Agent not configured');

    // The user message we echo back; the SDK assigns no user-message id (the
    // user content lands on the chat as a side-effect), so synthesize one.
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: opts.content,
      createdAt: new Date().toISOString(),
    };

    let res: any;
    try {
      res = await this.client.send(
        new SendMessageCommand({
          agentSpaceId: opts.agentSpaceId,
          executionId: opts.executionId,
          content: opts.content,
          // NB: userId is deprecated/ignored by the service - do NOT send it.
        } as any),
      );
    } catch (e: any) {
      throw new Error(`SendMessage failed: ${e?.message ?? e}`);
    }

    const reply = await this.assembleReplyFromStream(
      res?.events,
      opts.executionId,
    );
    // A normal completed stream always yields text; only return pending if the
    // backstop timeout tripped before responseCompleted.
    return reply ? { userMessage, reply } : { userMessage, pending: true };
  }

  /**
   * Drain a SendMessage event stream and assemble the assistant reply.
   *
   * Each content block is keyed by `index` and typed via contentBlockStart
   * (`text`, `final_response`, `context_usage`, `chat_title`). Text arrives as
   * contentBlockDelta.delta.textDelta.text. We accumulate per-block text, then
   * prefer the `final_response` block (the canonical answer); if there's none,
   * we fall back to concatenating `text` blocks. `context_usage` (JSON
   * telemetry) and `chat_title` are never part of the reply body.
   *
   * Returns undefined if the stream errored (responseFailed throws) or the
   * backstop timeout elapsed before any usable text.
   */
  private async assembleReplyFromStream(
    events: AsyncIterable<any> | undefined,
    executionId: string,
  ): Promise<ChatMessage | undefined> {
    if (!events || typeof (events as any)[Symbol.asyncIterator] !== 'function') {
      this.logger?.warn('devops-agent: SendMessage returned no event stream');
      return undefined;
    }

    const blockType = new Map<number, string>();
    const blockText = new Map<number, string>();
    let chatTitle: string | undefined;
    const deadline = Date.now() + DevOpsAgentService.REPLY_STREAM_TIMEOUT_MS;

    for await (const ev of events as AsyncIterable<any>) {
      if (Date.now() > deadline) {
        this.logger?.warn(
          `devops-agent: SendMessage stream timed out (executionId=${executionId})`,
        );
        break;
      }
      if (ev.contentBlockStart) {
        const i = ev.contentBlockStart.index ?? 0;
        if (typeof ev.contentBlockStart.type === 'string') {
          blockType.set(i, ev.contentBlockStart.type);
        }
        continue;
      }
      if (ev.contentBlockDelta) {
        const i = ev.contentBlockDelta.index ?? 0;
        const text = ev.contentBlockDelta.delta?.textDelta?.text;
        if (typeof text === 'string') {
          blockText.set(i, (blockText.get(i) ?? '') + text);
        }
        continue;
      }
      if (ev.responseFailed) {
        const f = ev.responseFailed;
        throw new Error(`agent failed: ${f.errorCode}: ${f.errorMessage}`);
      }
      if (ev.responseCompleted) {
        break;
      }
      // responseCreated / responseInProgress / contentBlockStop / heartbeat /
      // summary -> nothing to accumulate for the reply body.
    }

    // Pick the reply body: prefer final_response, else all text blocks joined.
    let finalText: string | undefined;
    const textParts: string[] = [];
    for (const [i, type] of blockType) {
      const t = blockText.get(i);
      if (!t) continue;
      if (type === 'final_response') finalText = t;
      else if (type === 'text') textParts.push(t);
      else if (type === 'chat_title') chatTitle = t;
      // context_usage and anything else: skip.
    }
    // Blocks with text but no recorded type (defensive): treat as text.
    for (const [i, t] of blockText) {
      if (!blockType.has(i) && t) textParts.push(t);
    }

    const body = (finalText ?? textParts.join('\n')).trim();
    if (!body) {
      // Completed but empty, or timed out before text: let caller mark pending.
      return undefined;
    }

    return {
      id: `assistant-${executionId}-${Date.now()}`,
      role: 'assistant',
      content: body,
      createdAt: new Date().toISOString(),
      ...(chatTitle
        ? { references: [{ title: chatTitle, kind: 'Chat title' }] }
        : {}),
    };
  }

  /**
   * Replay a chat's messages. The DevOps Agent SDK exposes no chat-transcript
   * read API (ListPendingMessages returns the agent's inbound queue, not the
   * conversation), so there is nothing durable to replay server-side: the
   * authoritative transcript lives in the agentSpace web app. We return an
   * empty list; the frontend keeps its in-memory/localStorage view and the
   * header links out to the web app for the full history.
   */
  async listMessages(opts: {
    executionId: string;
    agentSpaceId: string;
  }): Promise<ListMessagesResponse> {
    return { executionId: opts.executionId, messages: [] };
  }

  /** Coerce an SDK timestamp (Date | string | epoch ms) to ISO, or undefined. */
  private toIso(v: unknown): string | undefined {
    if (!v) return undefined;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return new Date(v).toISOString();
    return undefined;
  }
}
