import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';
import { Stack } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as eks from 'aws-cdk-lib/aws-eks-v2';
import { CfnAddon, CfnPodIdentityAssociation } from 'aws-cdk-lib/aws-eks';
import { KubectlV35Layer } from '@aws-cdk/lambda-layer-kubectl-v35';
import { NodeGroupConfig } from '../config/types';

export interface FleetEksProps {
  clusterName: string;
  version: string;
  vpc: ec2.IVpc;
  nodeGroups: NodeGroupConfig[];
  publicAccessCidrs: string[];
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

    // PUBLIC (not PUBLIC_AND_PRIVATE) on purpose. With private endpoint
    // access enabled, the aws-eks-v2 module attaches the kubectl-provider
    // Lambdas to the VPC so they can reach a private API endpoint. VPC-
    // attached Lambdas create Hyperplane ENIs that AWS only reclaims on a
    // slow async sweep, which drags out every `cdk destroy` (CloudFormation
    // blocks on subnet deletion until the ENIs clear). A public endpoint
    // (still IAM + RBAC protected) keeps the kubectl provider out of the VPC,
    // so deploy and destroy are both fast. Phase 7 hardening switches to a
    // private endpoint + accepts the slower teardown.
    const endpointAccess = props.publicAccessCidrs.length > 0
      ? eks.EndpointAccess.PUBLIC.onlyFrom(...props.publicAccessCidrs)
      : eks.EndpointAccess.PUBLIC;

    const kubectlLayer = new KubectlV35Layer(this, 'KubectlLayer');

    this.cluster = new eks.Cluster(this, 'Cluster', {
      clusterName: props.clusterName,
      version: this.parseVersion(props.version),
      vpc: props.vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      endpointAccess,
      defaultCapacityType: eks.DefaultCapacityType.NODEGROUP,
      defaultCapacity: 0,
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

    // Managed node groups. AL2023 is the only AMI option going forward;
    // EKS support for AL2 ended 2025-11-26 and EKS does not publish AL2
    // AMIs for K8s >= 1.33.
    //
    // We deliberately do NOT set `nodegroupName`. Any property change that
    // CFN models as 'replace' (e.g. amiType, capacityType) creates a new
    // nodegroup before deleting the old one - an explicit name causes a
    // 409 AlreadyExists collision. CFN-generated names work fine because
    // operators reference nodegroups by node labels (fleet.role) rather
    // than by EKS API name.
    const nodegroups: eks.Nodegroup[] = [];
    for (const ng of props.nodeGroups) {
      const nodegroup = this.cluster.addNodegroupCapacity(ng.name, {
        instanceTypes: ng.instanceTypes.map(t => new ec2.InstanceType(t)),
        amiType: eks.NodegroupAmiType.AL2023_X86_64_STANDARD,
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
      // NOTE: the EBS CSI *controller* gets its credentials via Pod Identity
      // (see the add-on loop below), NOT the node role - controller pods run
      // on the pod network and can't reach IMDS to assume the node role. The
      // node DaemonSet uses the node role over hostNetwork, but it only needs
      // the volume-attach permissions already in AmazonEKSWorkerNodePolicy.
      nodegroups.push(nodegroup);
    }

    // Managed add-ons. addonVersion is intentionally left unset so EKS
    // installs the latest version compatible with the cluster's K8s version
    // - the cluster always lands on current add-ons without us tracking
    // version strings. preserveOnDelete: false keeps teardown clean (the
    // default true orphans the add-on when the stack is destroyed).
    //
    // Three non-obvious settings, all learned the hard way:
    //
    //  - resolveConflicts OVERWRITE: the cluster is created with
    //    bootstrapSelfManagedAddons (the default), so EKS self-installs
    //    vpc-cni / kube-proxy / coredns first. Installing the *managed*
    //    add-on on top hits a field-ownership conflict; OVERWRITE lets the
    //    managed add-on take ownership instead of failing the deploy.
    //
    //  - DependsOn nodegroups: coredns and aws-ebs-csi-driver run
    //    controller Deployments that need schedulable nodes. Ordering the
    //    add-ons after the nodegroups means they don't come up Degraded for
    //    lack of anywhere to schedule.
    //
    //  - Pod Identity for aws-ebs-csi-driver: the EBS CSI *controller* runs
    //    on the pod network, so it cannot reach IMDS to assume the node
    //    role - it MUST get credentials via EKS Pod Identity bound to its
    //    service account (ebs-csi-controller-sa). The association is
    //    declared on the add-on itself (podIdentityAssociations) so the
    //    CloudFormation execution role creates it via iam:PassRole; doing it
    //    out-of-band requires PassRole on the human operator, which is often
    //    blocked by an SCP/permission boundary. The node DaemonSet does use
    //    the node role (hostNetwork -> IMDS works), but the controller is
    //    the one that calls CreateVolume/AttachVolume, so this is required.
    const podIdentityRoles: Record<string, iam.IManagedPolicy[]> = {
      'aws-ebs-csi-driver': [
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          'EbsCsiControllerPolicy',
          'arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy',
        ),
      ],
    };
    const addonServiceAccount: Record<string, string> = {
      'aws-ebs-csi-driver': 'ebs-csi-controller-sa',
    };

    for (const addonName of [
      'vpc-cni',
      'coredns',
      'kube-proxy',
      'aws-ebs-csi-driver',
      'eks-pod-identity-agent',
    ]) {
      const addon = new eks.Addon(this, `Addon-${addonName}`, {
        cluster: this.cluster,
        addonName,
        preserveOnDelete: false,
      });
      const cfnAddon = addon.node.defaultChild as CfnAddon;
      cfnAddon.resolveConflicts = 'OVERWRITE';
      for (const ng of nodegroups) {
        addon.node.addDependency(ng);
      }

      // Wire a dedicated IAM role + Pod Identity association for add-ons
      // whose controller needs AWS API access from the pod network.
      const managedPolicies = podIdentityRoles[addonName];
      if (managedPolicies) {
        const addonRole = new iam.Role(this, `AddonRole-${addonName}`, {
          description: `Fleet ${addonName} add-on controller role (EKS Pod Identity)`,
          assumedBy: new iam.ServicePrincipal('pods.eks.amazonaws.com'),
          managedPolicies,
        });
        addonRole.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
          actions: ['sts:AssumeRole', 'sts:TagSession'],
          principals: [new iam.ServicePrincipal('pods.eks.amazonaws.com')],
        }));
        // The Pod Identity agent add-on must exist before associations
        // resolve. It's in the same loop, so depend on the cluster being
        // up; the agent add-on is ordered by EKS, and associations are
        // re-tried by the controller until the agent is ready.
        cfnAddon.podIdentityAssociations = [{
          roleArn: addonRole.roleArn,
          serviceAccount: addonServiceAccount[addonName],
        }];
      }
    }

    // AWS Load Balancer Controller - fulfills `ingressClassName: alb` and
    // Service type=LoadBalancer (NLB). Not a managed EKS add-on, so it's a
    // Helm chart with its own IAM role + Pod Identity (same pattern as the
    // EBS CSI controller: runs on the pod network, needs creds via Pod
    // Identity, not IMDS).
    this.installAwsLoadBalancerController(props.vpc);
  }

  /**
   * Install the AWS Load Balancer Controller via Helm, wired to a dedicated
   * IAM role through EKS Pod Identity. Required for any ALB Ingress or NLB
   * Service in the cluster (e.g. the Backstage portal's Ingress).
   */
  private installAwsLoadBalancerController(vpc: ec2.IVpc): void {
    const policyJson = JSON.parse(fs.readFileSync(
      path.join(__dirname, '../policies/aws-load-balancer-controller-iam-policy.json'),
      'utf8',
    ));

    const role = new iam.Role(this, 'AlbControllerRole', {
      description: 'AWS Load Balancer Controller role (EKS Pod Identity)',
      assumedBy: new iam.ServicePrincipal('pods.eks.amazonaws.com'),
    });
    role.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      principals: [new iam.ServicePrincipal('pods.eks.amazonaws.com')],
    }));
    // Attach the official controller policy (16 statements) as an inline doc.
    new iam.Policy(this, 'AlbControllerPolicy', {
      document: iam.PolicyDocument.fromJson(policyJson),
      roles: [role],
    });

    const sa = 'aws-load-balancer-controller';
    this.addPodIdentity(this, {
      id: 'AlbControllerPodIdentity',
      namespace: 'kube-system',
      serviceAccount: sa,
      role,
    });

    const chart = new eks.HelmChart(this, 'AlbController', {
      cluster: this.cluster,
      chart: 'aws-load-balancer-controller',
      repository: 'https://aws.github.io/eks-charts',
      release: 'aws-load-balancer-controller',
      // Chart 1.17.1 -> controller v2.17.1, matched to the IAM policy in
      // lib/policies/. (The chart's 3.x line is a separate, newer track.)
      version: '1.17.1',
      namespace: 'kube-system',
      wait: true,
      values: {
        clusterName: this.cluster.clusterName,
        region: Stack.of(this).region,
        vpcId: vpc.vpcId,
        serviceAccount: { create: true, name: sa },
        // The controller's own pods must schedule; the system nodegroup is
        // tainted, so tolerate it (kube-system DaemonSet-style components do).
        tolerations: [
          { key: 'dedicated', value: 'system', operator: 'Equal', effect: 'NoSchedule' },
        ],
      },
    });
    // The controller pods need the Pod Identity association (and thus the
    // pod-identity-agent add-on) to obtain AWS credentials. Helm waits on
    // pod readiness, so ensure the association exists first.
    chart.node.addDependency(role);
  }

  private sanitizeId(arn: string): string {
    // Construct IDs must be alnum + `-`. ARNs contain `:`, `/`, etc.
    return arn.replace(/[^A-Za-z0-9]/g, '').slice(-32);
  }

  private parseVersion(v: string): eks.KubernetesVersion {
    const map: Record<string, eks.KubernetesVersion> = {
      '1.32': eks.KubernetesVersion.V1_32,
      '1.33': eks.KubernetesVersion.V1_33,
      '1.34': eks.KubernetesVersion.V1_34,
      '1.35': eks.KubernetesVersion.V1_35,
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
