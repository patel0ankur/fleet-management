/**
 * Hand-maintained TS types mirroring config/platform.schema.json.
 * Keep in sync if the schema changes.
 */

export type TaintEffect = 'NO_SCHEDULE' | 'PREFER_NO_SCHEDULE' | 'NO_EXECUTE';

export interface NodeGroupConfig {
  name: string;
  instanceTypes: string[];
  minSize: number;
  maxSize: number;
  desiredSize?: number;
  labels?: Record<string, string>;
  taints?: Array<{ key: string; value: string; effect: TaintEffect }>;
}

export interface PlatformConfig {
  apiVersion: 'fleet.platform/v1';
  kind: 'PlatformConfig';
  metadata: {
    name: string;
    org: string;
  };
  spec: {
    aws: {
      sharedServicesAccount: string;
      region: string;
      tags?: Record<string, string>;
    };
    network: {
      vpcCidr: string;
      azCount: number;
      natGateways: number;
      publicAccessCidrs: string[];
    };
    eks: {
      name: string;
      version: string;
      nodeGroups: NodeGroupConfig[];
      /**
       * IAM principal ARNs that should receive cluster-admin via an EKS
       * Access Entry. Add the ARN of whoever runs `fleetctl deploy` so
       * `kubectl` works without an out-of-band create-access-entry call.
       */
      adminPrincipalArns?: string[];
    };
    identity: {
      idc: {
        instanceArn: string;
        region: string;
        adminGroupId: string;
        adminGroupType?: 'SSO_GROUP' | 'SSO_USER';
      };
    };
    gitops: {
      repoUrl: string;
      branch: string;
      pathPrefix: string;
      sshKeySecretArn?: string;
      tokenSecretArn?: string;
    };
    capabilities: {
      ack?: boolean;
      kro?: boolean;
      argocd?: boolean;
    };
    observability?: {
      devopsAgentWebhookSecretArn?: string;
      devopsAgent?: {
        enabled?: boolean;
        agentSpaceId?: string;
        region?: string;
      };
    };
    cost?: {
      curBucket?: string;
    };
    developerPortal?: {
      enabled: boolean;
      host?: string;
      githubOrg?: string;
      githubTokenSecretArn?: string;
      oidcClientSecretArn?: string;
      catalogRepoGlob?: string;
    };
  };
}

/**
 * Defaults applied after schema validation but before stacks read values.
 */
export const CONFIG_DEFAULTS = {
  network: {
    vpcCidr: '10.40.0.0/16',
    azCount: 3,
    natGateways: 1,
    publicAccessCidrs: [] as string[],
  },
  gitops: {
    branch: 'main',
    pathPrefix: 'clusters/control',
  },
  capabilities: {
    ack: true,
    kro: true,
    argocd: true,
  },
  eks: {
    adminPrincipalArns: [] as string[],
  },
  idc: {
    adminGroupType: 'SSO_GROUP' as const,
  },
  developerPortal: {
    catalogRepoGlob: 'projects/*/catalog-info.yaml',
  },
} as const;
