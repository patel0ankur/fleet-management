// Types + constants shared between the DevOps Agent frontend and backend
// plugins. Mirrors the awslabs SecurityHub plugin's `common` package.

/**
 * Annotation that opts a catalog entity into the DevOps Agent "Incidents" tab.
 * Value is a comma-separated tag filter applied to the agentSpace's
 * investigations, e.g. "service=hello,project=smoke-team". An entity without
 * this annotation does not show the tab.
 */
export const DEVOPS_AGENT_TAGS_ANNOTATION = 'aws.amazon.com/devops-agent-tags';

/** A single DevOps Agent investigation (backlog task) surfaced on an entity. */
export interface DevOpsAgentIncident {
  taskId: string;
  title: string;
  status: string;
  priority: string;
  taskType: string;
  createdAt?: string;
  updatedAt?: string;
  executionId?: string;
  /** Deep link to the investigation in the DevOps Agent web app. */
  url?: string;
}

/** Backend response for "incidents for this entity". */
export interface DevOpsAgentIncidentsResponse {
  /** False when the plugin isn't configured (no agentSpaceId). */
  configured: boolean;
  agentSpaceId?: string;
  incidents: DevOpsAgentIncident[];
}
