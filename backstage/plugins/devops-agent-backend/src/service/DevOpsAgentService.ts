import {
  DevOpsAgentClient,
  ListBacklogTasksCommand,
  CreateBacklogTaskCommand,
} from '@aws-sdk/client-devops-agent';
import { LoggerService } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import {
  DevOpsAgentIncident,
  DevOpsAgentIncidentsResponse,
} from '@internal/plugin-devops-agent-common';

/**
 * Reads DevOps Agent investigations (backlog tasks) for a configured
 * agentSpace and filters them to a given entity's tag set. AWS credentials
 * come from the default chain - in our cluster that's the Backstage pod's EKS
 * Pod Identity role (mirrors how the awslabs SecurityHub plugin resolves
 * creds via the Backstage backend's IAM identity).
 */
export class DevOpsAgentService {
  private readonly client?: DevOpsAgentClient;
  private readonly consoleBase: string;

  private constructor(
    private readonly agentSpaceId: string,
    region: string,
  ) {
    this.client = agentSpaceId
      ? new DevOpsAgentClient({ region })
      : undefined;
    this.consoleBase = `https://${region}.console.aws.amazon.com/devops-agent/home?region=${region}`;
  }

  static fromConfig(config: Config, _opts: { logger: LoggerService }) {
    const conf = config.getOptionalConfig('aws.devopsAgent');
    // Use getOptional (untyped) + coerce, NOT getOptionalString: Backstage's
    // config reader throws "got empty-string, wanted string" on an empty
    // value, and agentSpaceId is empty until an agentSpace is provisioned.
    const asStr = (v: unknown): string =>
      typeof v === 'string' ? v : '';
    const region =
      asStr(conf?.getOptional('region')) ||
      asStr(config.getOptional('aws.region')) ||
      'us-east-1';
    const agentSpaceId = asStr(conf?.getOptional('agentSpaceId'));
    return new DevOpsAgentService(agentSpaceId, region);
  }

  get configured(): boolean {
    return !!this.client;
  }

  /**
   * @param tags comma-separated `k=v` pairs from the entity annotation; an
   *   investigation matches if its title/description contains every value
   *   (the agent API has no structured tag filter on backlog tasks, so we
   *   match on the reference + text - good enough for surfacing).
   */
  async incidentsForEntity(tags: string): Promise<DevOpsAgentIncidentsResponse> {
    if (!this.client) {
      return { configured: false, incidents: [] };
    }
    const wanted = tags
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    const incidents: DevOpsAgentIncident[] = [];
    let nextToken: string | undefined;
    do {
      const res = await this.client.send(
        new ListBacklogTasksCommand({
          agentSpaceId: this.agentSpaceId,
          nextToken,
          limit: 50,
        } as any),
      );
      const tasks: any[] = (res as any).tasks ?? (res as any).backlogTasks ?? [];
      for (const t of tasks) {
        const hay = `${t.title ?? ''} ${t.description ?? ''} ${t.reference?.title ?? ''} ${t.reference?.referenceId ?? ''}`.toLowerCase();
        const match = wanted.every(w => hay.includes(w.toLowerCase()));
        if (!match) continue;
        incidents.push({
          taskId: t.taskId,
          title: t.title ?? t.taskId,
          status: t.status ?? 'UNKNOWN',
          priority: t.priority ?? 'MINIMAL',
          taskType: t.taskType ?? 'INVESTIGATION',
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          executionId: t.executionId,
          url: `${this.consoleBase}#/investigations/${t.taskId}`,
        });
      }
      nextToken = (res as any).nextToken;
    } while (nextToken);

    return {
      configured: true,
      agentSpaceId: this.agentSpaceId,
      incidents,
    };
  }

  /**
   * Start a DevOps Agent investigation for an entity. The entity's tags are
   * embedded in the title + reference so the subsequent ListBacklogTasks
   * filter picks it up on the same Component's Incidents tab.
   */
  async startInvestigation(opts: {
    title: string;
    description?: string;
    priority?: string;
    tags: string;
    entityRef: string;
  }): Promise<DevOpsAgentIncident> {
    if (!this.client) {
      throw new Error('DevOps Agent not configured (no agentSpaceId)');
    }
    const priority = (opts.priority || 'HIGH').toUpperCase();
    // Embed the tag values in the title so text-based ListBacklogTasks
    // matching associates this investigation back to the entity.
    const title = `${opts.title} [${opts.tags}]`.slice(0, 400);
    const res = await this.client.send(
      new CreateBacklogTaskCommand({
        agentSpaceId: this.agentSpaceId,
        taskType: 'INVESTIGATION',
        priority,
        title,
        description:
          opts.description ||
          `Investigation started from Backstage for ${opts.entityRef} (tags: ${opts.tags}).`,
        reference: {
          system: 'backstage',
          title: opts.entityRef,
          referenceId: opts.entityRef,
        },
      } as any),
    );
    const t: any = (res as any).task ?? {};
    return {
      taskId: t.taskId,
      title: t.title ?? title,
      status: t.status ?? 'CREATED',
      priority: t.priority ?? priority,
      taskType: t.taskType ?? 'INVESTIGATION',
      createdAt: t.createdAt,
      executionId: t.executionId,
      url: `${this.consoleBase}#/investigations/${t.taskId}`,
    };
  }
}
