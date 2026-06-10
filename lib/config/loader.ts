import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { CONFIG_DEFAULTS, PlatformConfig } from './types';

const SCHEMA_PATH = path.resolve(__dirname, '../../config/platform.schema.json');

let ajv: Ajv2020 | undefined;
let validateFn: ReturnType<Ajv2020['compile']> | undefined;

function getValidator() {
  if (validateFn) return validateFn;
  ajv = new Ajv2020({ allErrors: true, useDefaults: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  validateFn = ajv.compile(schema);
  return validateFn;
}

/**
 * Read, parse, validate, and apply defaults to a platform.yaml file.
 * Throws with a multi-line diagnostic if validation fails.
 */
export function loadPlatformConfig(filePath: string): PlatformConfig {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `platform config not found at ${filePath}. ` +
      `Run 'fleetctl init' or 'cp config/platform.example.yaml config/platform.yaml'.`
    );
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = yaml.load(raw) as unknown;

  const validate = getValidator();
  const ok = validate(parsed);
  if (!ok) {
    const errs = (validate.errors ?? [])
      .map(e => `  ${e.instancePath || '/'}: ${e.message}`)
      .join('\n');
    throw new Error(`platform.yaml failed schema validation:\n${errs}`);
  }

  const config = parsed as PlatformConfig;
  applyDefaults(config);
  postValidate(config);
  return config;
}

function applyDefaults(c: PlatformConfig): void {
  c.spec.network = {
    ...CONFIG_DEFAULTS.network,
    ...c.spec.network,
  };
  c.spec.gitops = {
    ...CONFIG_DEFAULTS.gitops,
    ...c.spec.gitops,
  };
  c.spec.capabilities = {
    ...CONFIG_DEFAULTS.capabilities,
    ...(c.spec.capabilities ?? {}),
  };
  if (!c.spec.eks.adminPrincipalArns) {
    c.spec.eks.adminPrincipalArns = [...CONFIG_DEFAULTS.eks.adminPrincipalArns];
  }
  if (!c.spec.identity.idc.adminGroupType) {
    c.spec.identity.idc.adminGroupType = CONFIG_DEFAULTS.idc.adminGroupType;
  }
}

function postValidate(c: PlatformConfig): void {
  // Catch values copied from platform.example.yaml without editing.
  const placeholders: Array<[string, string]> = [
    [c.spec.aws.sharedServicesAccount, 'spec.aws.sharedServicesAccount is the placeholder "111111111111"'],
    [c.spec.identity.idc.instanceArn, 'spec.identity.idc.instanceArn is the placeholder "ssoins-XXXXXXXXXXXXXXXX"'],
    [c.spec.identity.idc.adminGroupId, 'spec.identity.idc.adminGroupId is the placeholder "00000000-0000-0000-0000-000000000000"'],
  ];
  for (const [val, msg] of placeholders) {
    if (/^(111111111111|0+(-0+)+|ssoins-X+)$/i.test(val) || val.includes('XXXX') || val.includes('00000000-0000-0000-0000')) {
      throw new Error(`platform.yaml: ${msg}. Replace it before running deploy.`);
    }
  }
  for (const arn of c.spec.eks.adminPrincipalArns ?? []) {
    if (/^arn:aws:iam::111111111111:/.test(arn)) {
      throw new Error(
        `platform.yaml: spec.eks.adminPrincipalArns still contains the example ARN ${arn}. ` +
        `Replace it with the IAM role/user that will run 'fleetctl deploy'.`,
      );
    }
  }
  if ((c.spec.eks.adminPrincipalArns ?? []).length === 0) {
    throw new Error(
      `platform.yaml: spec.eks.adminPrincipalArns is empty. ` +
      `Add at least one IAM role/user ARN; otherwise kubectl will return 401 after deploy.`,
    );
  }

  // Cross-field rules that JSON Schema can't express.
  for (const ng of c.spec.eks.nodeGroups) {
    if (ng.maxSize < ng.minSize) {
      throw new Error(`nodeGroup '${ng.name}': maxSize (${ng.maxSize}) < minSize (${ng.minSize})`);
    }
    if (ng.desiredSize !== undefined && (ng.desiredSize < ng.minSize || ng.desiredSize > ng.maxSize)) {
      throw new Error(
        `nodeGroup '${ng.name}': desiredSize (${ng.desiredSize}) outside [min=${ng.minSize}, max=${ng.maxSize}]`
      );
    }
  }
  if (c.spec.network.natGateways > c.spec.network.azCount) {
    throw new Error(
      `natGateways (${c.spec.network.natGateways}) cannot exceed azCount (${c.spec.network.azCount})`
    );
  }
  // Private gitops needs a credential. Heuristic: anything that's not http(s) anonymous
  // OR that's clearly a private host. We require a secret for git@/ssh:// and warn-only otherwise.
  const isSsh = /^(git@|ssh:\/\/)/.test(c.spec.gitops.repoUrl);
  if (isSsh && !c.spec.gitops.sshKeySecretArn) {
    throw new Error(`gitops.repoUrl is SSH but gitops.sshKeySecretArn is empty`);
  }
}
