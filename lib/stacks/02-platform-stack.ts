import { Construct } from 'constructs';
import { Stack, StackProps, CfnOutput, Arn } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { HelmChart, KubernetesManifest } from 'aws-cdk-lib/aws-eks-v2';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
  PhysicalResourceIdReference,
} from 'aws-cdk-lib/custom-resources';
import { BootstrapStack } from './01-bootstrap-stack';
import { EksCapability } from '../constructs/eks-capability';
import { FleetEks } from '../constructs/fleet-eks';
import { PlatformConfig } from '../config/types';

export interface PlatformStackProps extends StackProps {
  config: PlatformConfig;
  bootstrap: BootstrapStack;
}

/**
 * Phase 1 - Stack 2 (capabilities edition).
 *
 * Installs:
 *   - ACK    capability  (managed AWS Controllers for Kubernetes)
 *   - kro    capability  (Kube Resource Orchestrator)
 *   - ArgoCD capability  (managed Argo CD with hosted UI, IdC SSO)
 *
 * Plus Secrets Store CSI Driver + AWS provider (ASCP) for mounting secrets
 * from AWS Secrets Manager / SSM directly into workload pods. Auth is per
 * workload via Pod Identity on the consumer's service account; this stack
 * just installs the driver.
 *
 * After this stack, day-2 platform changes flow through the GitOps repo,
 * picked up by an Argo Application authored in Phase 2.
 */
export class PlatformStack extends Stack {
  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);
    const { config, bootstrap } = props;
    const fleetEks = bootstrap.fleetEks;
    const cluster = fleetEks.cluster;
    const enabled = config.spec.capabilities;

    // --- Secrets Store CSI Driver + AWS provider (ASCP) ---
    // ASCP's chart bundles the upstream CSI driver as a sub-chart, so a
    // single install gives us both the DaemonSet and the AWS provider.
    new HelmChart(this, 'AscpProvider', {
      cluster,
      chart: 'secrets-store-csi-driver-provider-aws',
      release: 'secrets-provider-aws',
      repository: 'https://aws.github.io/secrets-store-csi-driver-provider-aws',
      version: '3.1.1',
      namespace: 'kube-system',
      createNamespace: false,
      wait: true,
      values: {
        // Bundled sub-chart config.
        'secrets-store-csi-driver': {
          install: true,
          syncSecret: { enabled: true },
          enableSecretRotation: true,
          rotationPollInterval: '60s',
          linux: {
            tolerations: [
              { key: 'dedicated', value: 'system', operator: 'Equal', effect: 'NoSchedule' },
            ],
          },
        },
        tolerations: [
          { key: 'dedicated', value: 'system', operator: 'Equal', effect: 'NoSchedule' },
        ],
      },
    });

    // --- ACK capability ---
    if (enabled.ack) {
      // Phase 1: AdministratorAccess to streamline getting started, per AWS docs.
      // Phase 7 hardening switches to IAM Role Selectors.
      const ack = new EksCapability(this, 'AckCapability', {
        clusterName: cluster.clusterName,
        capabilityName: `fleet-${config.metadata.name}-ack`,
        type: 'ACK',
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')],
      });
      new CfnOutput(this, 'AckCapabilityArn', { value: ack.capability.attrArn });
    }

    // --- kro capability ---
    if (enabled.kro) {
      const kro = new EksCapability(this, 'KroCapability', {
        clusterName: cluster.clusterName,
        capabilityName: `fleet-${config.metadata.name}-kro`,
        type: 'KRO',
        // kro doesn't make AWS API calls; trust policy only.
      });
      new CfnOutput(this, 'KroCapabilityArn', { value: kro.capability.attrArn });

      // The kro capability auto-creates an Access Entry with AmazonEKSKROPolicy,
      // which only grants permissions on RGDs and instances. To compose other
      // resources (ACK CRs, native K8s objects) kro needs broader RBAC. For
      // Phase 1 we attach AmazonEKSClusterAdminPolicy; Phase 7 narrows this
      // (custom RBAC bound to the eks-access-entry:<role-arn> group).
      const adminPolicyArn = 'arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy';
      const kroRbacAssoc = new AwsCustomResource(this, 'KroRbacAssociation', {
        installLatestAwsSdk: false,
        onCreate: {
          service: 'EKS',
          action: 'AssociateAccessPolicy',
          parameters: {
            clusterName: cluster.clusterName,
            principalArn: kro.role.roleArn,
            policyArn: adminPolicyArn,
            accessScope: { type: 'cluster' },
          },
          physicalResourceId: PhysicalResourceId.of(`${cluster.clusterName}-kro-rbac`),
        },
        onDelete: {
          service: 'EKS',
          action: 'DisassociateAccessPolicy',
          parameters: {
            clusterName: cluster.clusterName,
            principalArn: kro.role.roleArn,
            policyArn: adminPolicyArn,
          },
        },
        policy: AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['eks:AssociateAccessPolicy', 'eks:DisassociateAccessPolicy', 'eks:DescribeAccessEntry'],
            resources: ['*'],
          }),
        ]),
      });
      kroRbacAssoc.node.addDependency(kro.capability);
    }

    // --- ArgoCD capability ---
    if (enabled.argocd) {
      const idc = config.spec.identity.idc;
      const argo = new EksCapability(this, 'ArgoCdCapability', {
        clusterName: cluster.clusterName,
        capabilityName: `fleet-${config.metadata.name}-argocd`,
        type: 'ARGOCD',
        argoCd: {
          idcInstanceArn: idc.instanceArn,
          idcRegion: idc.region,
          rbac: [
            {
              role: 'ADMIN',
              identities: [{ id: idc.adminGroupId, type: idc.adminGroupType ?? 'SSO_GROUP' }],
            },
          ],
        },
      });
      new CfnOutput(this, 'ArgoCdCapabilityArn', { value: argo.capability.attrArn });
      new CfnOutput(this, 'ArgoCdServerUrl', { value: argo.capability.attrConfigurationArgoCdServerUrl });
      new CfnOutput(this, 'ArgoCdIdcAppArn', { value: argo.capability.attrConfigurationArgoCdAwsIdcIdcManagedApplicationArn });

      // The Argo CD capability auto-creates an Access Entry for its Capability
      // Role with no Kubernetes permissions. Without an associated access
      // policy, every Application reconcile fails with "cluster is disabled".
      // For Phase 1 we attach AmazonEKSClusterAdminPolicy; Phase 7 will
      // narrow this to the production least-privilege pattern (custom RBAC
      // bound to the eks-access-entry:<role-arn> group).
      const adminPolicyArn = 'arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy';
      const argoRbacAssoc = new AwsCustomResource(this, 'ArgoCdRbacAssociation', {
        installLatestAwsSdk: false,
        onCreate: {
          service: 'EKS',
          action: 'AssociateAccessPolicy',
          parameters: {
            clusterName: cluster.clusterName,
            principalArn: argo.role.roleArn,
            policyArn: adminPolicyArn,
            accessScope: { type: 'cluster' },
          },
          physicalResourceId: PhysicalResourceId.of(`${cluster.clusterName}-argocd-rbac`),
        },
        onDelete: {
          service: 'EKS',
          action: 'DisassociateAccessPolicy',
          parameters: {
            clusterName: cluster.clusterName,
            principalArn: argo.role.roleArn,
            policyArn: adminPolicyArn,
          },
        },
        policy: AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['eks:AssociateAccessPolicy', 'eks:DisassociateAccessPolicy', 'eks:DescribeAccessEntry'],
            resources: ['*'],
          }),
        ]),
      });
      argoRbacAssoc.node.addDependency(argo.capability);

      // Compute the cluster ARN. The managed Argo CD capability uses the EKS
      // cluster ARN (not https://kubernetes.default.svc) as the Application
      // destination server.
      const clusterArn = Arn.format(
        { service: 'eks', resource: 'cluster', resourceName: cluster.clusterName },
        this,
      );

      // Register the local cluster as an Argo CD destination. Without this,
      // Applications in the cluster cannot deploy back into the same cluster
      // (capability ships with no destinations preconfigured).
      const inClusterSecret = new KubernetesManifest(this, 'ArgoInClusterSecret', {
        cluster,
        manifest: [{
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name: 'in-cluster',
            namespace: 'argocd',
            labels: { 'argocd.argoproj.io/secret-type': 'cluster' },
          },
          stringData: {
            name: 'in-cluster',
            server: clusterArn,
            project: 'default',
          },
        }],
      });
      inClusterSecret.node.addDependency(argoRbacAssoc);

      // Bootstrap App-of-Apps Application. Watches `<gitops.pathPrefix>` in
      // the GitOps repo recursively. Phase 2+ adds CRDs/templates/etc. as
      // folders under that path; nothing else needs to change here.
      const gitops = config.spec.gitops;
      const bootstrapApp = new KubernetesManifest(this, 'ArgoBootstrapApp', {
        cluster,
        manifest: [{
          apiVersion: 'argoproj.io/v1alpha1',
          kind: 'Application',
          metadata: {
            name: 'fleet-bootstrap',
            namespace: 'argocd',
            annotations: { 'argocd.argoproj.io/sync-wave': '0' },
          },
          spec: {
            project: 'default',
            source: {
              repoURL: gitops.repoUrl,
              targetRevision: gitops.branch,
              path: gitops.pathPrefix,
              directory: { recurse: true },
            },
            destination: {
              server: clusterArn,
              namespace: 'argocd',
            },
            syncPolicy: {
              automated: { prune: true, selfHeal: true },
              syncOptions: ['CreateNamespace=true', 'ApplyOutOfSyncOnly=true'],
            },
          },
        }],
      });
      bootstrapApp.node.addDependency(inClusterSecret);

      // Argo CD UI health checks for kro CRs.
      //
      // KNOWN LIMITATION: The managed Argo CD capability does not currently
      // merge user-supplied customizations from `argocd-cm`. The ConfigMap
      // here is forward-compatible (it lands in the cluster, and the AWS
      // implementation may begin honoring it without our involvement) but
      // today these Lua scripts are not picked up. The fleet-bootstrap App
      // therefore stays cosmetically Synced/Progressing forever; child Apps
      // that contain native Deployments/Services still report Healthy.
      //
      // Tracking item; revisit when AWS publishes capability documentation
      // for argocd-cm customizations.
      const argoHealthCm = new KubernetesManifest(this, 'ArgoHealthChecksCm', {
        cluster,
        overwrite: true,
        manifest: [{
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: {
            name: 'argocd-cm',
            namespace: 'argocd',
            labels: {
              'app.kubernetes.io/name': 'argocd-cm',
              'app.kubernetes.io/part-of': 'argocd',
            },
          },
          data: {
            'resource.customizations.health.kro.run_ResourceGraphDefinition': [
              'hs = {}',
              'if obj.status ~= nil and obj.status.state == "Active" then',
              '  hs.status = "Healthy"',
              '  hs.message = "kro RGD active"',
              '  return hs',
              'end',
              'hs.status = "Progressing"',
              'hs.message = "kro RGD reconciling"',
              'return hs',
            ].join('\n'),
            // Catch-all for kro instance kinds. kro instances expose a state
            // field at the top of status: ACTIVE, IN_PROGRESS, ERROR.
            'resource.customizations.health.kro.run_': [
              'hs = {}',
              'if obj.status ~= nil and obj.status.state == "ACTIVE" then',
              '  hs.status = "Healthy"',
              '  hs.message = "kro instance active"',
              '  return hs',
              'end',
              'if obj.status ~= nil and obj.status.state == "ERROR" then',
              '  hs.status = "Degraded"',
              '  hs.message = "kro instance error"',
              '  return hs',
              'end',
              'hs.status = "Progressing"',
              'hs.message = "kro instance reconciling"',
              'return hs',
            ].join('\n'),
            // ACK CRs: Healthy when the ACK.ResourceSynced condition is True.
            'resource.customizations.health.s3.services.k8s.aws_Bucket': ackResourceSyncedHealthLua(),
            'resource.customizations.health.iam.services.k8s.aws_Role': ackResourceSyncedHealthLua(),
            'resource.customizations.health.iam.services.k8s.aws_Policy': ackResourceSyncedHealthLua(),
            'resource.customizations.health.eks.services.k8s.aws_PodIdentityAssociation': ackResourceSyncedHealthLua(),
          },
        }],
      });
      argoHealthCm.node.addDependency(argoRbacAssoc);

      // Patch the auto-created `default` AppProject so its destinations include
      // the cluster ARN (the capability seeds it with kubernetes.default.svc,
      // which the capability itself rejects).
      const defaultProject = new KubernetesManifest(this, 'ArgoDefaultProject', {
        cluster,
        overwrite: true,
        manifest: [{
          apiVersion: 'argoproj.io/v1alpha1',
          kind: 'AppProject',
          metadata: { name: 'default', namespace: 'argocd' },
          spec: {
            description: 'Default project (Fleet-managed). Allows the bootstrap App to deploy into the local cluster.',
            sourceRepos: ['*'],
            destinations: [
              { server: clusterArn, namespace: '*' },
              { name: 'in-cluster', namespace: '*' },
            ],
            clusterResourceWhitelist: [{ group: '*', kind: '*' }],
            namespaceResourceWhitelist: [{ group: '*', kind: '*' }],
          },
        }],
      });
      defaultProject.node.addDependency(argoRbacAssoc);
      bootstrapApp.node.addDependency(defaultProject);

      new CfnOutput(this, 'ArgoCdClusterDestination', { value: clusterArn });
    }

    new CfnOutput(this, 'CapabilitiesEnabled', {
      value: Object.entries(enabled).filter(([, v]) => v).map(([k]) => k).join(','),
    });

    if (config.spec.developerPortal?.enabled) {
      this.addBackstageBootstrap(config, fleetEks);
    }
  }

  /**
   * Phase 3 - bootstrap items for the Backstage developer portal that only
   * CDK can do. The Helm chart, Argo Application, namespace, SecretProviderClass
   * and values all live in fleet-gitops under clusters/control/40-backstage/.
   *
   * Three responsibilities:
   *   1. IAM role with trust pods.eks.amazonaws.com, scoped to read the two
   *      Secrets Manager secrets (GitHub token, OIDC client secret).
   *   2. Pod Identity association binding namespace=backstage SA=backstage
   *      to the role.
   *   3. IdC customer-managed application that Backstage signs users into.
   *      The Argo CD capability creates its own; the Backstage one needs to
   *      be created here via sso-admin APIs.
   */
  private addBackstageBootstrap(config: PlatformConfig, eks: FleetEks) {
    const dp = config.spec.developerPortal!;

    const role = new iam.Role(this, 'BackstageRole', {
      roleName: `fleet-${config.metadata.name}-backstage`,
      description: 'Fleet Backstage workload role - reads platform secrets via ASCP.',
      assumedBy: new iam.ServicePrincipal('pods.eks.amazonaws.com'),
      inlinePolicies: {
        readSecrets: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
              resources: [dp.githubTokenSecretArn!, dp.oidcClientSecretArn!],
            }),
          ],
        }),
      },
    });
    role.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      principals: [new iam.ServicePrincipal('pods.eks.amazonaws.com')],
    }));

    eks.addPodIdentity(this, {
      id: 'BackstagePodIdentity',
      namespace: 'backstage',
      serviceAccount: 'backstage',
      role,
    });

    // IdC customer-managed application. The application is the trust
    // boundary; assignments grant a group access; the per-app PutApplicationGrant
    // configures the OAuth/OIDC issuer flows. AWS surfaces the issuer URL +
    // client_id post-create; the operator pastes those into the secret in
    // Secrets Manager out-of-band (same pattern as gitops.tokenSecretArn).
    const appName = `fleet-${config.metadata.name}-backstage`;
    const idcApp = new AwsCustomResource(this, 'BackstageIdcApplication', {
      installLatestAwsSdk: false,
      onCreate: {
        service: 'SSOAdmin',
        action: 'CreateApplication',
        parameters: {
          ApplicationProviderArn: 'arn:aws:sso::aws:applicationProvider/custom',
          InstanceArn: config.spec.identity.idc.instanceArn,
          Name: appName,
          Description: 'Fleet Backstage developer portal (Phase 3)',
        },
        physicalResourceId: PhysicalResourceId.fromResponse('ApplicationArn'),
      },
      onDelete: {
        service: 'SSOAdmin',
        action: 'DeleteApplication',
        parameters: {
          ApplicationArn: new PhysicalResourceIdReference(),
        },
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'sso:CreateApplication',
            'sso:DeleteApplication',
            'sso:DescribeApplication',
            'sso:TagResource',
          ],
          resources: ['*'],
        }),
      ]),
    });

    const idcAppArn = idcApp.getResponseField('ApplicationArn');

    // The Argo CD capability's rbacRoleMappings use SSO_GROUP / SSO_USER,
    // but the sso-admin:CreateApplicationAssignment API expects the bare
    // GROUP / USER. Translate.
    const idcPrincipalType = (config.spec.identity.idc.adminGroupType ?? 'SSO_GROUP') === 'SSO_USER'
      ? 'USER' : 'GROUP';

    const idcAssignment = new AwsCustomResource(this, 'BackstageIdcAssignment', {
      installLatestAwsSdk: false,
      onCreate: {
        service: 'SSOAdmin',
        action: 'CreateApplicationAssignment',
        parameters: {
          ApplicationArn: idcAppArn,
          PrincipalId: config.spec.identity.idc.adminGroupId,
          PrincipalType: idcPrincipalType,
        },
        physicalResourceId: PhysicalResourceId.of(`${appName}-admin-assignment`),
      },
      onDelete: {
        service: 'SSOAdmin',
        action: 'DeleteApplicationAssignment',
        parameters: {
          ApplicationArn: idcAppArn,
          PrincipalId: config.spec.identity.idc.adminGroupId,
          PrincipalType: idcPrincipalType,
        },
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'sso:CreateApplicationAssignment',
            'sso:DeleteApplicationAssignment',
          ],
          resources: ['*'],
        }),
      ]),
    });
    idcAssignment.node.addDependency(idcApp);

    new CfnOutput(this, 'BackstageRoleArn', { value: role.roleArn });
    new CfnOutput(this, 'BackstageIdcApplicationArn', { value: idcAppArn });
    new CfnOutput(this, 'BackstageHost', { value: dp.host! });
    new CfnOutput(this, 'BackstageNextSteps', {
      value:
        'After deploy: open IdC console -> Applications -> ' + appName +
        ' -> set assignment method, configure OIDC trusted token issuer, copy clientId/clientSecret into ' +
        (dp.oidcClientSecretArn ?? '<oidcClientSecretArn>'),
    });
  }
}

/**
 * Argo CD Lua health script for any ACK resource: Healthy when the
 * ACK.ResourceSynced condition is True; Degraded on Terminal; otherwise
 * Progressing.
 */
function ackResourceSyncedHealthLua(): string {
  return [
    'hs = {}',
    'if obj.status ~= nil and obj.status.conditions ~= nil then',
    '  for _, c in ipairs(obj.status.conditions) do',
    '    if c.type == "ACK.ResourceSynced" and c.status == "True" then',
    '      hs.status = "Healthy"; hs.message = "ACK resource synced"; return hs',
    '    end',
    '    if c.type == "ACK.Terminal" and c.status == "True" then',
    '      hs.status = "Degraded"; hs.message = c.message or "ACK terminal"; return hs',
    '    end',
    '  end',
    'end',
    'hs.status = "Progressing"; hs.message = "ACK reconciling"; return hs',
  ].join('\n');
}
