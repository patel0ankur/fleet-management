import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Tags } from 'aws-cdk-lib';

export interface FleetVpcProps {
  cidr: string;
  azCount: number;
  natGateways: number;
}

/**
 * VPC for the Fleet control cluster.
 * - 3 AZs by default, public + private subnets.
 * - VPC endpoints for AWS services to keep NAT traffic low.
 * - Subnet tags so EKS LBs auto-discover the right subnets.
 */
export class FleetVpc extends Construct {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: FleetVpcProps) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.cidr),
      maxAzs: props.azCount,
      natGateways: props.natGateways,
      subnetConfiguration: [
        { name: 'public',  subnetType: ec2.SubnetType.PUBLIC,                cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,   cidrMask: 22 },
      ],
      restrictDefaultSecurityGroup: true,
    });

    // Tags required for EKS LoadBalancer subnet discovery.
    for (const subnet of this.vpc.publicSubnets) {
      Tags.of(subnet).add('kubernetes.io/role/elb', '1');
    }
    for (const subnet of this.vpc.privateSubnets) {
      Tags.of(subnet).add('kubernetes.io/role/internal-elb', '1');
    }

    // Gateway endpoints (free, reduce NAT bytes).
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // Interface endpoints (charged, but cut cross-AZ NAT for chatty AWS APIs).
    const interfaceServices: Array<[string, ec2.InterfaceVpcEndpointAwsService]> = [
      ['EcrApi',  ec2.InterfaceVpcEndpointAwsService.ECR],
      ['EcrDkr',  ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
      ['Sts',     ec2.InterfaceVpcEndpointAwsService.STS],
      ['Ssm',     ec2.InterfaceVpcEndpointAwsService.SSM],
      ['Logs',    ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
      ['Ec2',     ec2.InterfaceVpcEndpointAwsService.EC2],
      ['Eks',     ec2.InterfaceVpcEndpointAwsService.EKS],
    ];
    for (const [name, service] of interfaceServices) {
      this.vpc.addInterfaceEndpoint(name, {
        service,
        privateDnsEnabled: true,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });
    }
  }
}
