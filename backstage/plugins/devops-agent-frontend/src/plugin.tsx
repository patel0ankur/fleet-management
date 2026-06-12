import {
  createFrontendPlugin,
  FrontendPlugin,
} from '@backstage/frontend-plugin-api';
import { EntityContentBlueprint } from '@backstage/plugin-catalog-react/alpha';
import { DEVOPS_AGENT_TAGS_ANNOTATION } from '@internal/plugin-devops-agent-common';

/**
 * "Incidents" entity tab, contributed via the NEW frontend system
 * (EntityContentBlueprint). Only shows for entities that carry the
 * devops-agent-tags annotation. Equivalent to the awslabs SecurityHub
 * plugin's EntityAwsSecurityHubContent, adapted from the old frontend system.
 *
 * Uses the function-form `filter` (an (entity)=>boolean) rather than a string
 * filter expression, to avoid ambiguity in the annotation-path grammar.
 */
const incidentsContent = EntityContentBlueprint.make({
  name: 'incidents',
  params: {
    path: '/incidents',
    title: 'Incidents',
    filter: (entity: { metadata?: { annotations?: Record<string, string> } }) =>
      Boolean(entity?.metadata?.annotations?.[DEVOPS_AGENT_TAGS_ANNOTATION]),
    loader: () =>
      import('./IncidentsContent').then(m => <m.IncidentsContent />),
  },
});

const devopsAgentPlugin: FrontendPlugin = createFrontendPlugin({
  pluginId: 'devops-agent',
  extensions: [incidentsContent],
});

export default devopsAgentPlugin;
