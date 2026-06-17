#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import { loadPlatformConfig } from '../lib/config/loader';
import { BootstrapStack } from '../lib/stacks/01-bootstrap-stack';
import { PlatformStack } from '../lib/stacks/02-platform-stack';

const app = new cdk.App();

const configFile = app.node.tryGetContext('configFile') as string | undefined;
if (!configFile) {
  throw new Error('Missing context "configFile". Pass --context configFile=config/platform.yaml');
}

const config = loadPlatformConfig(path.resolve(configFile));

const env: cdk.Environment = {
  account: config.spec.aws.sharedServicesAccount,
  region: config.spec.aws.region,
};

const stackNamePrefix = `fleet-${config.metadata.name}`;

// Stack-wide tags. CDK propagates these to every taggable resource in both
// stacks (VPC, subnets, EKS cluster, nodegroups, ASGs, ECR repos, IAM roles,
// security groups, etc.). User-supplied tags from platform.yaml come last so
// they can override our defaults if needed.
//
// `auto-delete=never` is required by Amazon's internal account janitor: any
// resource without this tag may be reaped by automated cleanup. We default it
// here so every Fleet-managed resource is protected; an operator who wants a
// teardown-friendly stack can override per-resource via spec.aws.tags.
const tags: Record<string, string> = {
  'fleet:managed-by': 'cdk',
  'fleet:org': config.metadata.org,
  'fleet:platform': config.metadata.name,
  'auto-delete': 'never',
  ...(config.spec.aws.tags ?? {}),
};

const bootstrap = new BootstrapStack(app, `${stackNamePrefix}-bootstrap`, {
  env,
  tags,
  description: 'Fleet Management - Phase 1 substrate (VPC, EKS, ECR, KMS)',
  config,
});

const platform = new PlatformStack(app, `${stackNamePrefix}-platform`, {
  env,
  tags,
  description: 'Fleet Management - Phase 1 control-plane software (ACK, kro, ArgoCD)',
  config,
  bootstrap,
});

platform.addDependency(bootstrap);

app.synth();
