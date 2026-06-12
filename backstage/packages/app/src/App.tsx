import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import catalogImportPlugin from '@backstage/plugin-catalog-import/alpha';
import scaffolderPlugin from '@backstage/plugin-scaffolder/alpha';
import searchPlugin from '@backstage/plugin-search/alpha';
import techdocsPlugin from '@backstage/plugin-techdocs/alpha';
import apiDocsPlugin from '@backstage/plugin-api-docs/alpha';
import orgPlugin from '@backstage/plugin-org/alpha';
import userSettingsPlugin from '@backstage/plugin-user-settings/alpha';
import kubernetesPlugin from '@backstage/plugin-kubernetes/alpha';
import devopsAgentPlugin from '@internal/plugin-devops-agent';
import { navModule } from './modules/nav';

// New frontend system: a plugin only mounts its routes if it's in `features`.
// The create-app scaffold registered only catalog + nav, so every other route
// (including the scaffolder and the default landing page) 404'd. Register the
// standard plugin set used by the Fleet portal.
export default createApp({
  features: [
    catalogPlugin,
    catalogImportPlugin,
    scaffolderPlugin,
    searchPlugin,
    techdocsPlugin,
    apiDocsPlugin,
    orgPlugin,
    userSettingsPlugin,
    kubernetesPlugin,
    devopsAgentPlugin,
    navModule,
  ],
});
