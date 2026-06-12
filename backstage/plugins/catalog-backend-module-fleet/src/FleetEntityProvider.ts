import {
  EntityProvider,
  EntityProviderConnection,
} from '@backstage/plugin-catalog-node';
import {
  Entity,
  GroupEntity,
  SystemEntity,
  ComponentEntity,
} from '@backstage/catalog-model';
import { LoggerService, SchedulerService } from '@backstage/backend-plugin-api';
import { KubeConfig, CustomObjectsApi } from '@kubernetes/client-node';

const KRO_GROUP = 'kro.run';
const KRO_VERSION = 'v1alpha1';
const KRO_PLURAL = 'statelessservicewithbuckets';
const ANNOTATION_PREFIX = 'fleet.platform.acme';
const IB_GROUP = 'platform.acme';
const IB_VERSION = 'v1alpha1';
const IB_PLURAL = 'incidentbindings';
const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, MINIMAL: 1,
};

/**
 * Reads Fleet kro instances (StatelessServiceWithBucket) directly from the
 * cluster and synthesizes Backstage entities - no hand-authored
 * catalog-info.yaml. This is the OpenChoreo `OpenChoreoEntityProvider`
 * pattern adapted to Fleet's GitOps-native model: the kro instances ARE the
 * source of truth, grouped by namespace (= Project).
 *
 *   namespace            -> Group (type team) + System
 *   each kro instance    -> Component (owned by the namespace Group,
 *                           partOf the namespace System), annotated with
 *                           backstage.io/kubernetes-id so the K8s plugin
 *                           shows its live workload, plus bucket/state info.
 */
export class FleetEntityProvider implements EntityProvider {
  private connection?: EntityProviderConnection;
  private readonly k8s: CustomObjectsApi;

  constructor(
    private readonly logger: LoggerService,
    private readonly scheduler: SchedulerService,
    private readonly opts: { frequencyMs: number; timeoutMs: number },
  ) {
    const kc = new KubeConfig();
    // In-cluster: uses the pod's mounted ServiceAccount token + CA.
    kc.loadFromCluster();
    this.k8s = kc.makeApiClient(CustomObjectsApi);
  }

  getProviderName(): string {
    return 'fleet-entity-provider';
  }

  async connect(connection: EntityProviderConnection): Promise<void> {
    this.connection = connection;
    await this.scheduler.scheduleTask({
      id: 'fleet-entity-provider-refresh',
      frequency: { milliseconds: this.opts.frequencyMs },
      timeout: { milliseconds: this.opts.timeoutMs },
      fn: async () => {
        try {
          await this.run();
        } catch (e) {
          this.logger.error(`Fleet entity refresh failed: ${e}`);
        }
      },
    });
  }

  async run(): Promise<void> {
    if (!this.connection) return;

    const res: any = await this.k8s.listClusterCustomObject(
      KRO_GROUP,
      KRO_VERSION,
      KRO_PLURAL,
    );
    const items: any[] = res?.body?.items ?? res?.items ?? [];
    this.logger.info(`Fleet provider: found ${items.length} kro instance(s)`);

    // Incidents (Phase 5): index active incidents by workload name so each
    // Component can show its open incidents + RCA links. Best-effort: if the
    // CRD/RBAC isn't present yet, log and continue without incident data.
    const incidentsByWorkload = new Map<string, any[]>();
    try {
      const ibRes: any = await this.k8s.listClusterCustomObject(
        IB_GROUP, IB_VERSION, IB_PLURAL,
      );
      const ibs: any[] = ibRes?.body?.items ?? ibRes?.items ?? [];
      for (const ib of ibs) {
        const wl = ib.spec?.deploymentRef?.name;
        const active = ib.status?.activeIncidents ?? [];
        if (wl && active.length) incidentsByWorkload.set(wl, active);
      }
      this.logger.info(
        `Fleet provider: ${incidentsByWorkload.size} workload(s) with active incidents`,
      );
    } catch (e) {
      this.logger.info(`Fleet provider: no incident data (${e})`);
    }

    const namespaces = new Set<string>();
    const components: ComponentEntity[] = [];

    for (const it of items) {
      const ns: string =
        it.metadata?.namespace ?? it.spec?.namespace ?? 'default';
      const name: string = it.metadata?.name ?? it.spec?.name;
      if (!name) continue;
      namespaces.add(ns);

      const state: string = it.status?.state ?? 'UNKNOWN';
      const bucketArn: string | undefined = it.status?.bucketArn;
      const image: string | undefined = it.spec?.image;
      const costCenter: string | undefined = it.spec?.costCenter;

      const annotations: Record<string, string> = {
        'backstage.io/managed-by-location': `fleet-provider:${ns}/${name}`,
        'backstage.io/managed-by-origin-location': `fleet-provider:${ns}/${name}`,
        'backstage.io/kubernetes-id': name,
        [`${ANNOTATION_PREFIX}/kro-state`]: state,
      };
      if (bucketArn) annotations[`${ANNOTATION_PREFIX}/bucket-arn`] = bucketArn;
      if (costCenter) annotations[`${ANNOTATION_PREFIX}/cost-center`] = costCenter;

      const links: Array<{ url: string; title: string }> = [];
      if (bucketArn) {
        links.push({
          url: `https://s3.console.aws.amazon.com/s3/buckets/${bucketArn.split(':::')[1] ?? ''}`,
          title: 'S3 bucket',
        });
      }

      // Phase 5: surface active incidents + RCA links on the Component.
      const incidents = incidentsByWorkload.get(name) ?? [];
      if (incidents.length) {
        annotations[`${ANNOTATION_PREFIX}/incidents-open`] = String(incidents.length);
        const maxSev = incidents
          .map((i: any) => i.severity ?? 'MINIMAL')
          .reduce((a: string, b: string) => (SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a), 'MINIMAL');
        annotations[`${ANNOTATION_PREFIX}/incident-max-severity`] = maxSev;
        const statuses = incidents
          .map((i: any) => i.executionStatus)
          .filter(Boolean);
        if (statuses.length) {
          annotations[`${ANNOTATION_PREFIX}/incident-status`] = statuses.join(',');
        }
        for (const inc of incidents) {
          if (inc.rcaUrl) {
            links.push({ url: inc.rcaUrl, title: `RCA: ${inc.title ?? inc.incidentId}` });
          }
        }
      }

      const tags: string[] = [];
      if (image) tags.push(`image:${image.split('/').pop()?.split(':')[0] ?? 'app'}`);
      if (incidents.length) tags.push('incident');

      const component: ComponentEntity = {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: {
          name,
          namespace: 'default',
          title: name,
          description:
            `${name} - StatelessServiceWithBucket (kro: ${state}` +
            (incidents.length ? `, ${incidents.length} incident(s)` : '') + ')',
          annotations,
          links: links.length ? links : undefined,
          tags: tags.length ? tags : undefined,
        },
        spec: {
          type: 'service',
          lifecycle: 'production',
          owner: `group:default/${ns}`,
          system: `system:default/${ns}`,
        },
      };
      components.push(component);
    }

    const groupsAndSystems: Entity[] = [];
    for (const ns of namespaces) {
      const group: GroupEntity = {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Group',
        metadata: {
          name: ns,
          namespace: 'default',
          description: `Fleet project ${ns}`,
          annotations: {
            'backstage.io/managed-by-location': `fleet-provider:group/${ns}`,
            'backstage.io/managed-by-origin-location': `fleet-provider:group/${ns}`,
            [`${ANNOTATION_PREFIX}/namespace`]: ns,
          },
        },
        spec: { type: 'team', children: [], members: ['guest'] },
      };
      const system: SystemEntity = {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'System',
        metadata: {
          name: ns,
          namespace: 'default',
          description: `Fleet project ${ns} workloads`,
          annotations: {
            'backstage.io/managed-by-location': `fleet-provider:system/${ns}`,
            'backstage.io/managed-by-origin-location': `fleet-provider:system/${ns}`,
          },
        },
        spec: { owner: `group:default/${ns}` },
      };
      groupsAndSystems.push(group, system);
    }

    const entities = [...groupsAndSystems, ...components];
    await this.connection.applyMutation({
      type: 'full',
      entities: entities.map(entity => ({
        entity,
        locationKey: this.getProviderName(),
      })),
    });
    this.logger.info(
      `Fleet provider: applied ${groupsAndSystems.length} group/system + ${components.length} component entities`,
    );
  }
}
