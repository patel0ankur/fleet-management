import {
  createBackendPlugin,
  coreServices,
} from '@backstage/backend-plugin-api';
import { createRouter } from './service/router';
import { DevOpsAgentService } from './service/DevOpsAgentService';

/**
 * DevOps Agent backend plugin. Phase 5 redesign: a genai-style chat surface
 * modeled on awslabs/backstage-plugins-for-aws/plugins/genai. Exposes:
 *   GET  /api/devops-agent/agentspace?entityRef=     resolve / lazy-create
 *   POST /api/devops-agent/chats                     CreateChat
 *   POST /api/devops-agent/chats/:chatId/messages    SendMessage
 *   GET  /api/devops-agent/chats/:chatId/messages    ListChatMessages
 *
 * The agentSpace is provisioned on demand the first time an entity's chat
 * is opened (CreateAgentSpace). Operators can pin a specific id via
 * `aws.devopsAgent.agentSpaceId` or per-entity annotation, but the default
 * path is zero-touch.
 */
export const devopsAgentPlugin = createBackendPlugin({
  pluginId: 'devops-agent',
  register(env) {
    env.registerInit({
      deps: {
        logger: coreServices.logger,
        httpRouter: coreServices.httpRouter,
        auth: coreServices.auth,
        httpAuth: coreServices.httpAuth,
        discovery: coreServices.discovery,
        config: coreServices.rootConfig,
      },
      async init({ logger, httpRouter, auth, httpAuth, discovery, config }) {
        const service = DevOpsAgentService.fromConfig(config, { logger });
        const router = await createRouter({ logger, service, discovery, auth, httpAuth });
        httpRouter.use(router);
        httpRouter.addAuthPolicy({ path: '/health', allow: 'unauthenticated' });
        logger.info(
          `DevOps Agent backend ready (configured=${service.configured})`,
        );
      },
    });
  },
});
