import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { CfnCapability } from 'aws-cdk-lib/aws-eks';

export type CapabilityType = 'ACK' | 'KRO' | 'ARGOCD';

export interface EksCapabilityProps {
  /**
   * Cluster name. Stays a string (not an ICluster) so that the capability
   * can live in a different stack from the cluster without creating a
   * cross-stack reference cycle.
   */
  clusterName: string;
  capabilityName: string;
  type: CapabilityType;
  /**
   * Inline managed policies to attach to the Capability Role. For ACK the
   * default in `getting-started` docs is AdministratorAccess; production
   * deployments should pass narrower policies + use IAM Role Selectors.
   * kro: leave empty.
   * Argo CD: leave empty unless using AWS Secrets Manager / CodeConnections.
   */
  managedPolicies?: iam.IManagedPolicy[];
  inlinePolicies?: { [name: string]: iam.PolicyDocument };
  /**
   * Argo CD-only configuration. Required when type === 'ARGOCD'.
   */
  argoCd?: {
    idcInstanceArn: string;
    idcRegion: string;
    namespace?: string;
    rbac: Array<{
      role: 'ADMIN' | 'EDITOR' | 'VIEWER';
      identities: Array<{ id: string; type: 'SSO_GROUP' | 'SSO_USER' }>;
    }>;
  };
}

/**
 * Wraps `AWS::EKS::Capability` plus its required IAM Capability Role with
 * the trust policy `capabilities.eks.amazonaws.com` (per AWS docs:
 * https://docs.aws.amazon.com/eks/latest/userguide/capability-role.html).
 *
 * One of these per (cluster, type). EKS rejects multiple capabilities of
 * the same type on a single cluster.
 */
export class EksCapability extends Construct {
  public readonly role: iam.Role;
  public readonly capability: CfnCapability;

  constructor(scope: Construct, id: string, props: EksCapabilityProps) {
    super(scope, id);

    if (props.type === 'ARGOCD' && !props.argoCd) {
      throw new Error(`EksCapability ${id}: argoCd config is required when type === 'ARGOCD'`);
    }

    this.role = new iam.Role(this, 'Role', {
      roleName: `fleet-${props.capabilityName}-capability`,
      assumedBy: new iam.ServicePrincipal('capabilities.eks.amazonaws.com'),
      description: `Fleet ${props.type} capability role`,
      managedPolicies: props.managedPolicies,
      inlinePolicies: props.inlinePolicies,
    });
    // Capability roles must allow both AssumeRole and TagSession.
    this.role.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      principals: [new iam.ServicePrincipal('capabilities.eks.amazonaws.com')],
    }));

    this.capability = new CfnCapability(this, 'Capability', {
      clusterName: props.clusterName,
      capabilityName: props.capabilityName,
      type: props.type,
      roleArn: this.role.roleArn,
      deletePropagationPolicy: 'RETAIN',
      ...(props.type === 'ARGOCD' && props.argoCd
        ? {
          configuration: {
            argoCd: {
              awsIdc: {
                idcInstanceArn: props.argoCd.idcInstanceArn,
                idcRegion: props.argoCd.idcRegion,
              },
              namespace: props.argoCd.namespace,
              rbacRoleMappings: props.argoCd.rbac.map(m => ({
                role: m.role,
                identities: m.identities.map(i => ({ id: i.id, type: i.type })),
              })),
            },
          },
        }
        : {}),
    });
  }
}
