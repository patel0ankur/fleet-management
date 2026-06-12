import { Construct } from 'constructs';
import { Duration, Stack, Arn } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { CfnAccessEntry } from 'aws-cdk-lib/aws-eks';
import { FleetEks } from './fleet-eks';

export interface IncidentPipelineProps {
  /** ECR repo holding the incident-enricher image (created in the bootstrap stack). */
  enricherRepo: ecr.IRepository;
  imageTag: string;
  fleetEks: FleetEks;
  /** DevOps Agent agentSpace id; empty => agent calls skipped (incidents still recorded). */
  agentSpaceId: string;
  agentRegion: string;
  pollSeconds: number;
}

/**
 * Phase 5 - incident -> RCA pipeline.
 *
 *   CloudWatch Alarm State Change / fleet.argo event
 *        -> EventBridge rule -> incident-enricher Lambda
 *        -> match IncidentBinding CR, open a DevOps Agent INVESTIGATION
 *           (CreateBacklogTask), patch CR .status.activeIncidents
 *   scheduled rule -> same Lambda (poll mode) -> ListExecutions -> update RCA status
 *
 * The Lambda reaches the cluster API with its own IAM role via an EKS access
 * entry bound to the `fleet-incident-writers` K8s group (a ClusterRole in
 * GitOps grants that group patch on incidentbindings/status).
 */
export class IncidentPipeline extends Construct {
  public static readonly K8S_GROUP = 'fleet-incident-writers';

  constructor(scope: Construct, id: string, props: IncidentPipelineProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const cluster = props.fleetEks.cluster;

    const dlq = new sqs.Queue(this, 'Dlq', {
      retentionPeriod: Duration.days(14),
    });

    const fn = new lambda.DockerImageFunction(this, 'Enricher', {
      functionName: `fleet-incident-enricher`,
      code: lambda.DockerImageCode.fromEcr(props.enricherRepo, { tagOrDigest: props.imageTag }),
      timeout: Duration.seconds(60),
      memorySize: 256,
      deadLetterQueue: dlq,
      environment: {
        CLUSTER_NAME: cluster.clusterName,
        AGENT_SPACE_ID: props.agentSpaceId,
        DEVOPS_AGENT_REGION: props.agentRegion,
      },
    });

    // IAM: describe the cluster (for endpoint/CA), read alarm/metric context,
    // resource tags (cost-center fallback), and call the DevOps Agent API.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['eks:DescribeCluster'],
      resources: [Arn.format({ service: 'eks', resource: 'cluster', resourceName: cluster.clusterName }, stack)],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:DescribeAlarms', 'cloudwatch:GetMetricData', 'tag:GetResources'],
      resources: ['*'],
    }));
    // DevOps Agent (aidevops) - control-plane investigation calls. Resource-
    // level ARNs for the agent aren't documented yet; scope to the action set.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'aidevops:CreateBacklogTask',
        'aidevops:GetBacklogTask',
        'aidevops:UpdateBacklogTask',
        'aidevops:ListExecutions',
        'aidevops:ListJournalRecords',
        'aidevops:GetRecommendation',
        'aidevops:ListRecommendations',
      ],
      resources: ['*'],
    }));

    // EKS access entry: let the Lambda role authenticate to the cluster API
    // as a member of the fleet-incident-writers group. RBAC for that group is
    // granted by a ClusterRole/Binding rendered into GitOps.
    new CfnAccessEntry(this, 'LambdaAccessEntry', {
      clusterName: cluster.clusterName,
      principalArn: fn.role!.roleArn,
      type: 'STANDARD',
      kubernetesGroups: [IncidentPipeline.K8S_GROUP],
    });

    // EventBridge: CloudWatch alarms entering ALARM + fleet.argo failures.
    new events.Rule(this, 'IncidentRule', {
      ruleName: 'fleet-incident-events',
      eventPattern: {
        source: ['aws.cloudwatch', 'fleet.argo'],
        detailType: ['CloudWatch Alarm State Change', 'Argo Workflow Failed'],
      },
      targets: [new targets.LambdaFunction(fn, { deadLetterQueue: dlq })],
    });

    // Scheduled poll to refresh RCA status from ListExecutions.
    new events.Rule(this, 'PollRule', {
      ruleName: 'fleet-incident-poll',
      schedule: events.Schedule.rate(Duration.seconds(props.pollSeconds)),
      targets: [new targets.LambdaFunction(fn, {
        event: events.RuleTargetInput.fromObject({ 'detail-type': 'fleet.incident.poll' }),
      })],
    });
  }
}
