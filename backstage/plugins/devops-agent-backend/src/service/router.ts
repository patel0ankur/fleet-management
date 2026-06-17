import {
  LoggerService,
  HttpAuthService,
  AuthService,
  DiscoveryService,
} from '@backstage/backend-plugin-api';
import { CatalogClient } from '@backstage/catalog-client';
import { InputError } from '@backstage/errors';
import express from 'express';
import Router from 'express-promise-router';
import { DevOpsAgentService } from './DevOpsAgentService';
import {
  DEVOPS_AGENT_TAGS_ANNOTATION,
  DEVOPS_AGENT_SPACE_ID_ANNOTATION,
} from '@internal/plugin-devops-agent-common';

export interface RouterOptions {
  logger: LoggerService;
  service: DevOpsAgentService;
  discovery: DiscoveryService;
  auth: AuthService;
  httpAuth: HttpAuthService;
}

/**
 * REST surface for the genai-style DevOps Agent plugin (Phase 5).
 *
 * Routes
 *   GET  /health                                      unauth liveness
 *   GET  /agentspace?entityRef=...                    resolve / lazy-create
 *   POST /chats                                       open a new chat for an entity
 *   POST /chats/:executionId/messages                 send a message in a chat
 *   GET  /chats/:executionId/messages?...             pull pending messages
 *
 * Naming note: a "chat" is identified by its DevOps Agent `executionId`
 * (that's the SDK's primary key for chat sessions). We keep that name on
 * the wire so the frontend doesn't have to translate.
 *
 * Every chat-bearing route resolves the entity via the catalog with the
 * caller's on-behalf-of token, then asserts the entity carries the
 * devops-agent-tags annotation - same opt-in gate as the frontend's tab
 * visibility filter, just enforced server-side.
 */
export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const { logger, service, discovery, auth, httpAuth } = options;
  const catalog = new CatalogClient({ discoveryApi: discovery });
  const router = Router();
  router.use(express.json());

  router.get('/health', (_req, res) => res.json({ status: 'ok' }));

  /** Helper: resolve entity by ref using the caller's on-behalf-of token. */
  async function loadEntityFor(req: express.Request, entityRef: string) {
    const creds = await httpAuth.credentials(req);
    const { token } = await auth.getPluginRequestToken({
      onBehalfOf: creds,
      targetPluginId: 'catalog',
    });
    return catalog.getEntityByRef(entityRef, { token });
  }

  /** Read tags + optional pinned agentSpace id from an entity's annotations. */
  function readBindings(entity: { metadata?: { annotations?: Record<string, string> } }): {
    tags?: string;
    entityAgentSpaceId?: string;
  } {
    const a = entity.metadata?.annotations ?? {};
    return {
      tags: a[DEVOPS_AGENT_TAGS_ANNOTATION],
      entityAgentSpaceId: a[DEVOPS_AGENT_SPACE_ID_ANNOTATION],
    };
  }

  // GET /agentspace?entityRef=component:default/hello
  // Returns the resolved agentSpace info for the entity. May lazily create
  // the Fleet-default agentSpace on first call.
  router.get('/agentspace', async (req, res) => {
    const entityRef = String(req.query.entityRef ?? '');
    if (!entityRef) throw new InputError('entityRef is required');
    const entity = await loadEntityFor(req, entityRef);
    if (!entity) {
      res.json({ status: 'NOT_CONFIGURED', message: 'entity not found' });
      return;
    }
    const { tags, entityAgentSpaceId } = readBindings(entity);
    if (!tags) {
      res.json({
        status: 'NOT_CONFIGURED',
        message: `entity has no ${DEVOPS_AGENT_TAGS_ANNOTATION} annotation`,
      });
      return;
    }
    const info = await service.resolveAgentSpace({ entityAgentSpaceId });
    res.json(info);
  });

  // POST /chats   { entityRef, initialMessage? }
  router.post('/chats', async (req, res) => {
    const { entityRef, initialMessage } = req.body ?? {};
    if (!entityRef) throw new InputError('entityRef is required');
    const entity = await loadEntityFor(req, String(entityRef));
    if (!entity) throw new InputError(`entity ${entityRef} not found`);
    const { tags, entityAgentSpaceId } = readBindings(entity);
    if (!tags) {
      throw new InputError(
        `entity ${entityRef} has no ${DEVOPS_AGENT_TAGS_ANNOTATION} annotation`,
      );
    }
    logger.info(`devops-agent: createChat for ${entityRef}`);
    try {
      const out = await service.createChat({
        entityRef: String(entityRef),
        tags,
        entityAgentSpaceId,
        initialMessage:
          typeof initialMessage === 'string' ? initialMessage : undefined,
      });
      res.status(201).json(out);
    } catch (e: any) {
      logger.error(`devops-agent: createChat failed: ${e?.message ?? e}`);
      throw e;
    }
  });

  // POST /chats/:executionId/messages   { agentSpaceId, content }
  router.post('/chats/:executionId/messages', async (req, res) => {
    const executionId = String(req.params.executionId);
    const { agentSpaceId, content } = req.body ?? {};
    if (!agentSpaceId) throw new InputError('agentSpaceId is required');
    if (typeof content !== 'string' || !content.trim()) {
      throw new InputError('content is required');
    }
    const out = await service.sendMessage({
      executionId,
      agentSpaceId: String(agentSpaceId),
      content,
    });
    res.json(out);
  });

  // GET /chats/:executionId/messages?agentSpaceId=...
  router.get('/chats/:executionId/messages', async (req, res) => {
    const executionId = String(req.params.executionId);
    const agentSpaceId = String(req.query.agentSpaceId ?? '');
    if (!agentSpaceId) throw new InputError('agentSpaceId is required');
    const out = await service.listMessages({ executionId, agentSpaceId });
    res.json(out);
  });

  return router;
}
