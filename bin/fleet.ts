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

const tags: Record<string, string> = {
  'fleet:managed-by': 'cdk',
  'fleet:org': config.metadata.org,
  'fleet:platform': config.metadata.name,
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
