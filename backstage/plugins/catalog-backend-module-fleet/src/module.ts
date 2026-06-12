import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node/alpha';
import { FleetEntityProvider } from './FleetEntityProvider';

/**
 * Backend module that registers the FleetEntityProvider with the catalog.
 * Auto-discovers Fleet kro instances and emits Group/System/Component
 * entities, replacing hand-authored catalog-info.yaml for Fleet workloads.
 */
export const catalogModuleFleet = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'fleet-entity-provider',
  register(reg) {
    reg.registerInit({
      deps: {
        catalog: catalogProcessingExtensionPoint,
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
        config: coreServices.rootConfig,
      },
      async init({ catalog, logger, scheduler, config }) {
        const freqMs =
          config.getOptionalNumber('fleet.catalog.refreshSeconds') ?? 60;
        catalog.addEntityProvider(
          new FleetEntityProvider(logger, scheduler, {
            frequencyMs: freqMs * 1000,
            timeoutMs: 30_000,
          }),
        );
        logger.info('Registered FleetEntityProvider');
      },
    });
  },
});
