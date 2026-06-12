import { LoggerService, HttpAuthService, AuthService } from '@backstage/backend-plugin-api';
import { CatalogClient } from '@backstage/catalog-client';
import { DiscoveryService } from '@backstage/backend-plugin-api';
import { InputError } from '@backstage/errors';
import express from 'express';
import Router from 'express-promise-router';
import { DevOpsAgentService } from './DevOpsAgentService';
import { DEVOPS_AGENT_TAGS_ANNOTATION } from '@internal/plugin-devops-agent-common';

export interface RouterOptions {
  logger: LoggerService;
  service: DevOpsAgentService;
  discovery: DiscoveryService;
  auth: AuthService;
  httpAuth: HttpAuthService;
}

export async function createRouter(options: RouterOptions): Promise<express.Router> {
  const { logger, service, discovery, auth, httpAuth } = options;
  const catalog = new CatalogClient({ discoveryApi: discovery });
  const router = Router();
  router.use(express.json());

  router.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // GET /incidents?entityRef=component:default/hello
  router.get('/incidents', async (req, res) => {
    const entityRef = String(req.query.entityRef ?? '');
    if (!entityRef) throw new InputError('entityRef is required');

    const creds = await httpAuth.credentials(req);
    const { token } = await auth.getPluginRequestToken({
      onBehalfOf: creds,
      targetPluginId: 'catalog',
    });
    const entity = await catalog.getEntityByRef(entityRef, { token });
    if (!entity) {
      res.json({ configured: service.configured, incidents: [] });
      return;
    }
    const tags = entity.metadata.annotations?.[DEVOPS_AGENT_TAGS_ANNOTATION];
    if (!tags) {
      res.json({ configured: service.configured, incidents: [] });
      return;
    }
    logger.info(`devops-agent: incidents for ${entityRef} (tags=${tags})`);
    res.json(await service.incidentsForEntity(tags));
  });

  // POST /investigations  { entityRef, title?, description?, priority? }
  // Starts a DevOps Agent investigation for the entity.
  router.post('/investigations', async (req, res) => {
    const { entityRef, title, description, priority } = req.body ?? {};
    if (!entityRef) throw new InputError('entityRef is required');

    const creds = await httpAuth.credentials(req);
    const { token } = await auth.getPluginRequestToken({
      onBehalfOf: creds,
      targetPluginId: 'catalog',
    });
    const entity = await catalog.getEntityByRef(String(entityRef), { token });
    if (!entity) throw new InputError(`entity ${entityRef} not found`);
    const tags = entity.metadata.annotations?.[DEVOPS_AGENT_TAGS_ANNOTATION];
    if (!tags) {
      throw new InputError(
        `entity ${entityRef} has no ${DEVOPS_AGENT_TAGS_ANNOTATION} annotation`,
      );
    }
    logger.info(`devops-agent: starting investigation for ${entityRef}`);
    const incident = await service.startInvestigation({
      title: title || `Investigate ${entity.metadata.name}`,
      description,
      priority,
      tags,
      entityRef: String(entityRef),
    });
    res.status(201).json(incident);
  });

  return router;
}
