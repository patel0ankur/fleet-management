import {
  createBackendPlugin,
  coreServices,
} from '@backstage/backend-plugin-api';
import { createRouter } from './service/router';
import { DevOpsAgentService } from './service/DevOpsAgentService';

/**
 * DevOps Agent backend plugin. Exposes /api/devops-agent/incidents?entityRef=
 * which reads the entity's devops-agent-tags annotation and returns matching
 * DevOps Agent investigations. Modeled on the awslabs SecurityHub backend.
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
