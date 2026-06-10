import { Construct } from 'constructs';
import { Stack, StackProps, CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { FleetVpc } from '../constructs/fleet-vpc';
import { FleetEks } from '../constructs/fleet-eks';
import { PlatformConfig } from '../config/types';

export interface BootstrapStackProps extends StackProps {
  config: PlatformConfig;
}

/**
 * Phase 1 — Stack 1.
 *
 * Provisions the substrate Fleet runs on:
 *   - VPC + endpoints
 *   - EKS control cluster (managed nodegroups, Pod Identity, KMS-encrypted secrets)
 *   - ECR repos for Fleet-managed images
 *   - KMS keys (EKS secrets, ECR encryption)
 *
 * After Phase 1 this stack should rarely change. EKS version bumps and new
 * regions are the main reasons.
 */
export class BootstrapStack extends Stack {
  public readonly fleetVpc: FleetVpc;
  public readonly fleetEks: FleetEks;
  public readonly ecrRepos: Record<string, ecr.Repository>;

  constructor(scope: Construct, id: string, props: BootstrapStackProps) {
    super(scope, id, props);
    const { config } = props;

    // KMS — EKS secrets envelope encryption.
    const eksSecretsKey = new kms.Key(this, 'EksSecretsKey', {
      alias: `alias/fleet/${config.metadata.name}/eks`,
      description: 'Fleet EKS secrets envelope encryption',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // KMS — ECR image encryption.
    const ecrKey = new kms.Key(this, 'EcrKey', {
      alias: `alias/fleet/${config.metadata.name}/ecr`,
      description: 'Fleet ECR image encryption',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // VPC.
    this.fleetVpc = new FleetVpc(this, 'Network', {
      cidr: config.spec.network.vpcCidr,
      azCount: config.spec.network.azCount,
      natGateways: config.spec.network.natGateways,
    });

    // EKS.
    this.fleetEks = new FleetEks(this, 'Cluster', {
      clusterName: config.spec.eks.name,
      version: config.spec.eks.version,
      vpc: this.fleetVpc.vpc,
      nodeGroups: config.spec.eks.nodeGroups,
      publicAccessCidrs: config.spec.network.publicAccessCidrs,
      secretsKey: eksSecretsKey,
      adminPrincipalArns: config.spec.eks.adminPrincipalArns ?? [],
    });

    // ECR repos. Pre-created here so Phase 3+ image builds have a destination.
    this.ecrRepos = {};
    for (const name of ['backstage', 'cost-exporter', 'incident-enricher']) {
      this.ecrRepos[name] = new ecr.Repository(this, `Ecr${this.titleCase(name)}`, {
        repositoryName: `fleet/${name}`,
        imageScanOnPush: true,
        encryption: ecr.RepositoryEncryption.KMS,
        encryptionKey: ecrKey,
        lifecycleRules: [
          { description: 'keep last 30 images', maxImageCount: 30 },
          { description: 'expire untagged after 14 days', tagStatus: ecr.TagStatus.UNTAGGED, maxImageAge: Duration.days(14) },
        ],
        removalPolicy: RemovalPolicy.RETAIN,
      });
    }

    // GitHub Actions OIDC trust — used by release.yml to push images.
    // Created lazily; only meaningful if the customer wires their fork's repo into the trust policy.
    const ghOidc = new iam.OpenIdConnectProvider(this, 'GitHubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });
    new iam.Role(this, 'FleetPlatformAdmin', {
      roleName: `fleet-${config.metadata.name}-platform-admin`,
      description: 'Assumed by GitHub Actions to push Fleet images & manage platform repos',
      assumedBy: new iam.OpenIdConnectPrincipal(ghOidc, {
        StringLike: {
          [`token.actions.githubusercontent.com:sub`]: `repo:${config.metadata.org}/*:*`,
        },
      }),
      // Intentionally narrow; expand only if needed.
      inlinePolicies: {
        EcrPush: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ecr:GetAuthorizationToken'],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              actions: [
                'ecr:BatchCheckLayerAvailability',
                'ecr:CompleteLayerUpload',
                'ecr:InitiateLayerUpload',
                'ecr:PutImage',
                'ecr:UploadLayerPart',
                'ecr:DescribeImages',
                'ecr:DescribeRepositories',
              ],
              resources: Object.values(this.ecrRepos).map(r => r.repositoryArn),
            }),
          ],
        }),
      },
    });

    // Outputs consumed by PlatformStack and fleetctl.
    new CfnOutput(this, 'ClusterName', { value: this.fleetEks.cluster.clusterName });
    new CfnOutput(this, 'ClusterEndpoint', { value: this.fleetEks.cluster.clusterEndpoint });
    new CfnOutput(this, 'VpcId', { value: this.fleetVpc.vpc.vpcId });
    new CfnOutput(this, 'EcrBackstageUri', { value: this.ecrRepos.backstage.repositoryUri });
    new CfnOutput(this, 'KmsEksKeyArn', { value: eksSecretsKey.keyArn });
  }

  private titleCase(s: string): string {
    return s.split('-').map(p => p[0].toUpperCase() + p.slice(1)).join('');
  }
}
