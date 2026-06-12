'use strict';
// Minimal EKS-authenticated Kubernetes client for a Lambda OUTSIDE the cluster.
//
// A Lambda can't use the in-cluster ServiceAccount token (it isn't a pod), so
// we authenticate the way `aws eks get-token` does: a presigned STS
// GetCallerIdentity URL, base64url-encoded as the bearer token
// "k8s-aws-v1.<token>". The cluster must have an EKS access entry (or aws-auth
// mapping) for the Lambda's role granting RBAC to read/patch IncidentBindings.
const https = require('https');
const { EKSClient, DescribeClusterCommand } = require('@aws-sdk/client-eks');
const { Sha256 } = require('@aws-crypto/sha256-js');
const { SignatureV4 } = require('@smithy/signature-v4');
const { HttpRequest } = require('@smithy/protocol-http');
const { defaultProvider } = require('@aws-sdk/credential-provider-node');

const REGION = process.env.AWS_REGION || 'us-east-1';
const CLUSTER_NAME = process.env.CLUSTER_NAME;

let cached; // { endpoint, ca }

async function clusterInfo() {
  if (cached) return cached;
  const eks = new EKSClient({ region: REGION });
  const r = await eks.send(new DescribeClusterCommand({ name: CLUSTER_NAME }));
  cached = {
    endpoint: r.cluster.endpoint,
    ca: Buffer.from(r.cluster.certificateAuthority.data, 'base64'),
  };
  return cached;
}

// Build the EKS bearer token: a SigV4-presigned STS GetCallerIdentity URL,
// 60s TTL, with the x-k8s-aws-id header bound to the cluster name.
async function eksToken() {
  const creds = await defaultProvider()();
  const signer = new SignatureV4({
    service: 'sts',
    region: REGION,
    credentials: creds,
    sha256: Sha256,
  });
  const request = new HttpRequest({
    method: 'GET',
    protocol: 'https:',
    hostname: `sts.${REGION}.amazonaws.com`,
    path: '/',
    query: {
      Action: 'GetCallerIdentity',
      Version: '2011-06-15',
    },
    headers: {
      host: `sts.${REGION}.amazonaws.com`,
      'x-k8s-aws-id': CLUSTER_NAME,
    },
  });
  const presigned = await signer.presign(request, { expiresIn: 60 });
  const qs = Object.entries(presigned.query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const url = `https://${presigned.hostname}${presigned.path}?${qs}`;
  const b64 = Buffer.from(url).toString('base64url');
  return `k8s-aws-v1.${b64.replace(/=+$/, '')}`;
}

// Low-level JSON request to the cluster API server.
async function apiRequest(method, path, body) {
  const { endpoint, ca } = await clusterInfo();
  const token = await eksToken();
  const u = new URL(endpoint + path);
  const payload = body ? JSON.stringify(body) : undefined;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (payload) {
    // JSON merge patch for status updates.
    headers['Content-Type'] =
      method === 'PATCH' ? 'application/merge-patch+json' : 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers, ca },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data ? JSON.parse(data) : {});
          } else {
            reject(new Error(`k8s ${method} ${path} -> ${res.statusCode}: ${data}`));
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const GROUP = 'platform.acme';
const VERSION = 'v1alpha1';
const PLURAL = 'incidentbindings';

async function listIncidentBindings() {
  const r = await apiRequest('GET', `/apis/${GROUP}/${VERSION}/${PLURAL}`);
  return r.items || [];
}

async function patchIncidentBindingStatus(namespace, name, status) {
  // /status subresource, merge patch.
  return apiRequest(
    'PATCH',
    `/apis/${GROUP}/${VERSION}/namespaces/${namespace}/${PLURAL}/${name}/status`,
    { status },
  );
}

module.exports = { listIncidentBindings, patchIncidentBindingStatus };
