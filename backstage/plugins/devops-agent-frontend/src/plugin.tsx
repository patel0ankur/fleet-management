import {
  createFrontendPlugin,
  FrontendPlugin,
} from '@backstage/frontend-plugin-api';
import { EntityContentBlueprint } from '@backstage/plugin-catalog-react/alpha';
import { DEVOPS_AGENT_TAGS_ANNOTATION } from '@internal/plugin-devops-agent-common';

/**
 * "DevOps Agent" entity tab. Phase 5 redesign: a genai-style interactive chat,
 * modeled on awslabs/backstage-plugins-for-aws/plugins/genai. Replaces the
 * earlier incidents-table tab.
 *
 * Visibility: only entities carrying the `aws.amazon.com/devops-agent-tags`
 * annotation see the tab (function-form filter). Fleet stamps this annotation
 * automatically on every workload Component via FleetEntityProvider.
 */
const chatContent = EntityContentBlueprint.make({
  name: 'devops-agent-chat',
  params: {
    path: '/devops-agent',
    title: 'DevOps Agent',
    filter: (entity: { metadata?: { annotations?: Record<string, string> } }) =>
      Boolean(entity?.metadata?.annotations?.[DEVOPS_AGENT_TAGS_ANNOTATION]),
    loader: () =>
      import('./ChatContent').then(m => <m.ChatContent />),
  },
});

const devopsAgentPlugin: FrontendPlugin = createFrontendPlugin({
  pluginId: 'devops-agent',
  extensions: [chatContent],
});

export default devopsAgentPlugin;
