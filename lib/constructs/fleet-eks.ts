import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as eks from 'aws-cdk-lib/aws-eks-v2';
import { CfnPodIdentityAssociation } from 'aws-cdk-lib/aws-eks';
import { KubectlV31Layer } from '@aws-cdk/lambda-layer-kubectl-v31';
import { NodeGroupConfig } from '../config/types';

export interface FleetEksProps {
  clusterName: string;
  version: string;
  vpc: ec2.IVpc;
  nodeGroups: NodeGroupConfig[];
  publicAccessCidrs: string[];
  secretsKey: kms.IKey;
  /**
   * IAM principal ARNs that get cluster-admin via Access Entries. Without
   * this, only the CDK CFN execution role (which created the cluster) has
   * cluster-admin and `kubectl` from a developer workstation returns 401.
   */
  adminPrincipalArns: string[];
}

/**
 * EKS control cluster for Fleet.
 *
 * Uses the stabilized eks-v2 module which is API-auth-mode-only and Pod
 * Identity-friendly (no aws-auth ConfigMap, no IRSA-by-default).
 */
export class FleetEks extends Construct {
  public readonly cluster: eks.Cluster;

  constructor(scope: Construct, id: string, props: FleetEksProps) {
    super(scope, id);

    const endpointAccess = props.publicAccessCidrs.length > 0
      ? eks.EndpointAccess.PUBLIC_AND_PRIVATE.onlyFrom(...props.publicAccessCidrs)
      : eks.EndpointAccess.PUBLIC_AND_PRIVATE;

    const kubectlLayer = new KubectlV31Layer(this, 'KubectlLayer');

    this.cluster = new eks.Cluster(this, 'Cluster', {
      clusterName: props.clusterName,
      version: this.parseVersion(props.version),
      vpc: props.vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      endpointAccess,
      defaultCapacityType: eks.DefaultCapacityType.NODEGROUP,
      defaultCapacity: 0,
      secretsEncryptionKey: props.secretsKey,
      kubectlProviderOptions: {
        kubectlLayer,
      },
    });

    // Grant cluster-admin to each configured admin principal via an Access Entry.
    // The cluster's auto-Access-Entry only covers the CDK CFN execution role;
    // the human running deploys won't have kubectl access without this.
    for (const arn of props.adminPrincipalArns) {
      this.cluster.grantClusterAdmin(`Admin-${this.sanitizeId(arn)}`, arn);
    }

    // Managed node groups.
    for (const ng of props.nodeGroups) {
      this.cluster.addNodegroupCapacity(ng.name, {
        nodegroupName: ng.name,
        instanceTypes: ng.instanceTypes.map(t => new ec2.InstanceType(t)),
        minSize: ng.minSize,
        maxSize: ng.maxSize,
        desiredSize: ng.desiredSize ?? ng.minSize,
        labels: ng.labels,
        taints: ng.taints?.map(t => ({
          key: t.key,
          value: t.value,
          effect: this.taintEffect(t.effect),
        })),
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });
    }

    // Pin add-on versions explicitly so cdk diff is meaningful.
    new eks.Addon(this, 'AddonVpcCni',           { cluster: this.cluster, addonName: 'vpc-cni' });
    new eks.Addon(this, 'AddonCoreDns',          { cluster: this.cluster, addonName: 'coredns' });
    new eks.Addon(this, 'AddonKubeProxy',        { cluster: this.cluster, addonName: 'kube-proxy' });
    new eks.Addon(this, 'AddonEbsCsi',           { cluster: this.cluster, addonName: 'aws-ebs-csi-driver' });
    new eks.Addon(this, 'AddonPodIdentityAgent', { cluster: this.cluster, addonName: 'eks-pod-identity-agent' });
  }

  private sanitizeId(arn: string): string {
    // Construct IDs must be alnum + `-`. ARNs contain `:`, `/`, etc.
    return arn.replace(/[^A-Za-z0-9]/g, '').slice(-32);
  }

  private parseVersion(v: string): eks.KubernetesVersion {
    const map: Record<string, eks.KubernetesVersion> = {
      '1.30': eks.KubernetesVersion.V1_30,
      '1.31': eks.KubernetesVersion.V1_31,
      '1.32': eks.KubernetesVersion.V1_32,
      '1.33': eks.KubernetesVersion.V1_33,
    };
    const out = map[v];
    if (!out) {
      throw new Error(`Unsupported EKS version '${v}'. Supported: ${Object.keys(map).join(', ')}`);
    }
    return out;
  }

  private taintEffect(e: 'NO_SCHEDULE' | 'PREFER_NO_SCHEDULE' | 'NO_EXECUTE'): eks.TaintEffect {
    switch (e) {
      case 'NO_SCHEDULE':         return eks.TaintEffect.NO_SCHEDULE;
      case 'PREFER_NO_SCHEDULE':  return eks.TaintEffect.PREFER_NO_SCHEDULE;
      case 'NO_EXECUTE':          return eks.TaintEffect.NO_EXECUTE;
    }
  }

  /**
   * Create a Pod Identity association binding a service account to an IAM role.
   * The L1 must be created in the *caller's* scope to avoid cross-stack cycles
   * when the role and cluster live in different stacks.
   */
  public addPodIdentity(scope: Construct, opts: {
    id: string;
    namespace: string;
    serviceAccount: string;
    role: iam.IRole;
  }): CfnPodIdentityAssociation {
    return new CfnPodIdentityAssociation(scope, opts.id, {
      clusterName: this.cluster.clusterName,
      namespace: opts.namespace,
      serviceAccount: opts.serviceAccount,
      roleArn: opts.role.roleArn,
    });
  }
}
