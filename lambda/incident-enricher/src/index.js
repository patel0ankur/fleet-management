'use strict';
// Fleet incident pipeline Lambda. Two entry points, selected by the event:
//
//  - ENRICHER (EventBridge: CloudWatch Alarm State Change / fleet.argo):
//      map the alarm -> the IncidentBinding it belongs to, open a DevOps Agent
//      INVESTIGATION (CreateBacklogTask), and record it on the CR .status.
//
//  - POLLER (EventBridge scheduled rule, detail-type 'fleet.incident.poll'):
//      for every active incident with a taskId, ListExecutions and update
//      executionStatus / rcaUrl on the CR .status.
//
// agentSpaceId empty => the agent calls are skipped; incidents are still
// recorded in CR status (agentSkipped:true) so the pipeline is demoable
// before the DevOps Agent agentSpace is provisioned.
const {
  DevOpsAgentClient,
  CreateBacklogTaskCommand,
  ListExecutionsCommand,
} = require('@aws-sdk/client-devops-agent');
const { listIncidentBindings, patchIncidentBindingStatus } = require('./k8s');

const REGION = process.env.AWS_REGION || 'us-east-1';
const AGENT_REGION = process.env.DEVOPS_AGENT_REGION || REGION;
const AGENT_SPACE_ID = process.env.AGENT_SPACE_ID || '';
const CONSOLE = `https://${AGENT_REGION}.console.aws.amazon.com`;

const agent = AGENT_SPACE_ID
  ? new DevOpsAgentClient({ region: AGENT_REGION })
  : null;

exports.handler = async event => {
  const detailType = event['detail-type'] || '';
  if (detailType === 'fleet.incident.poll') {
    return poll();
  }
  return enrich(event);
};

// ---- ENRICHER ----
async function enrich(event) {
  const src = event.source;
  const detail = event.detail || {};
  let alarmArn, namespace, deployment, reason, severity;

  if (src === 'aws.cloudwatch') {
    alarmArn = (event.resources || [])[0];
    reason = detail.state?.reason;
    // Pull namespace/deployment from the metric dimensions if present.
    const dims =
      detail.configuration?.metrics?.[0]?.metricStat?.metric?.dimensions || {};
    namespace = dims.Namespace || dims.namespace;
    deployment = dims.PodName || dims.Deployment || dims.deployment;
    if (detail.state?.value !== 'ALARM') {
      console.log(`alarm not in ALARM state (${detail.state?.value}); ignoring`);
      return { ignored: true };
    }
  } else if (src === 'fleet.argo') {
    namespace = detail.namespace;
    deployment = detail.deployment || detail.workflow;
    reason = detail.message || 'Argo workflow failed';
    severity = detail.severity;
  } else {
    console.log(`unhandled source ${src}; ignoring`);
    return { ignored: true };
  }

  // Find the IncidentBinding: prefer alarm-arn match, else deploymentRef.name.
  const bindings = await listIncidentBindings();
  const match = bindings.find(b => {
    const arns = (b.spec?.alarms || []).map(a => a.arn);
    if (alarmArn && arns.includes(alarmArn)) return true;
    return (
      deployment &&
      b.spec?.deploymentRef?.name === deployment &&
      (!namespace || b.metadata?.namespace === namespace)
    );
  });

  if (!match) {
    console.log(
      `no IncidentBinding for alarm=${alarmArn} ns=${namespace} deploy=${deployment}`,
    );
    return { matched: false };
  }

  const ns = match.metadata.namespace;
  const name = match.metadata.name;
  const workload = match.spec.deploymentRef.name;
  const prio =
    severity ||
    (alarmArn && match.spec?.alarms?.find(a => a.arn === alarmArn)?.severity) ||
    match.spec?.severity ||
    'HIGH';
  const incidentId = `inc-${workload}-${Date.now()}`;
  const title = `[${workload}] ${reason || 'incident'}`.slice(0, 400);

  const incident = {
    incidentId,
    title,
    severity: prio,
    alarmArn: alarmArn || '',
    openedAt: new Date().toISOString(),
  };

  if (agent) {
    try {
      const res = await agent.send(
        new CreateBacklogTaskCommand({
          agentSpaceId: AGENT_SPACE_ID,
          taskType: 'INVESTIGATION',
          priority: prio,
          title,
          description: `Fleet incident for workload ${workload} in namespace ${ns}. Reason: ${reason || 'n/a'}.`,
          reference: {
            system: 'fleet',
            title: workload,
            referenceId: incidentId,
            referenceUrl: alarmArn
              ? `${CONSOLE}/cloudwatch/home?region=${AGENT_REGION}#alarmsV2:alarm/${encodeURIComponent(alarmArn)}`
              : undefined,
          },
        }),
      );
      incident.taskId = res.task?.taskId;
      incident.executionId = res.task?.executionId;
      incident.executionStatus = res.task?.status || 'CREATED';
    } catch (e) {
      console.error(`CreateBacklogTask failed: ${e}`);
      incident.agentSkipped = true;
      incident.executionStatus = 'AGENT_ERROR';
    }
  } else {
    incident.agentSkipped = true;
    incident.executionStatus = 'AGENT_DISABLED';
  }

  const existing = match.status?.activeIncidents || [];
  await patchIncidentBindingStatus(ns, name, {
    activeIncidents: [...existing, incident],
  });
  console.log(`recorded ${incidentId} on ${ns}/${name} (taskId=${incident.taskId || 'none'})`);
  return { matched: true, incidentId, taskId: incident.taskId || null };
}

// ---- POLLER ----
async function poll() {
  if (!agent) {
    console.log('agent disabled; nothing to poll');
    return { polled: 0 };
  }
  const bindings = await listIncidentBindings();
  let updated = 0;
  for (const b of bindings) {
    const incidents = b.status?.activeIncidents || [];
    if (!incidents.length) continue;
    let changed = false;
    for (const inc of incidents) {
      if (!inc.taskId) continue;
      try {
        const res = await agent.send(
          new ListExecutionsCommand({ agentSpaceId: AGENT_SPACE_ID, taskId: inc.taskId, limit: 1 }),
        );
        const exec = res.executions?.[0];
        if (exec && exec.executionStatus !== inc.executionStatus) {
          inc.executionStatus = exec.executionStatus;
          inc.executionId = exec.executionId || inc.executionId;
          inc.rcaUrl = `${CONSOLE}/devops-agent/home?region=${AGENT_REGION}#/investigations/${inc.taskId}`;
          changed = true;
        }
      } catch (e) {
        console.error(`ListExecutions failed for ${inc.taskId}: ${e}`);
      }
    }
    if (changed) {
      await patchIncidentBindingStatus(b.metadata.namespace, b.metadata.name, {
        activeIncidents: incidents,
      });
      updated++;
    }
  }
  console.log(`poller updated ${updated} binding(s)`);
  return { polled: bindings.length, updated };
}
