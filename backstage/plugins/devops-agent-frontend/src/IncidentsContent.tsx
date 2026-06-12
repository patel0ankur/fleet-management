import { useEffect, useState } from 'react';
import { useEntity } from '@backstage/plugin-catalog-react';
import { useApi, discoveryApiRef, fetchApiRef } from '@backstage/core-plugin-api';
import {
  Table,
  TableColumn,
  Progress,
  EmptyState,
  Link,
  StatusOK,
  StatusError,
  StatusWarning,
  StatusPending,
} from '@backstage/core-components';
import {
  DEVOPS_AGENT_TAGS_ANNOTATION,
  DevOpsAgentIncident,
  DevOpsAgentIncidentsResponse,
} from '@internal/plugin-devops-agent-common';

function severityStatus(p: string) {
  switch ((p || '').toUpperCase()) {
    case 'CRITICAL':
    case 'HIGH':
      return <StatusError>{p}</StatusError>;
    case 'MEDIUM':
      return <StatusWarning>{p}</StatusWarning>;
    case 'LOW':
    case 'MINIMAL':
      return <StatusOK>{p}</StatusOK>;
    default:
      return <StatusPending>{p || 'UNKNOWN'}</StatusPending>;
  }
}

/** Tab content: DevOps Agent investigations for the current entity. */
export const IncidentsContent = () => {
  const { entity } = useEntity();
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const [state, setState] = useState<{
    loading: boolean;
    error?: Error;
    data?: DevOpsAgentIncidentsResponse;
  }>({ loading: true });

  const entityRef = `${entity.kind.toLowerCase()}:${
    entity.metadata.namespace ?? 'default'
  }/${entity.metadata.name}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const base = await discovery.getBaseUrl('devops-agent');
        const resp = await fetchApi.fetch(
          `${base}/incidents?entityRef=${encodeURIComponent(entityRef)}`,
        );
        if (!resp.ok) throw new Error(`backend returned ${resp.status}`);
        const data = (await resp.json()) as DevOpsAgentIncidentsResponse;
        if (!cancelled) setState({ loading: false, data });
      } catch (e) {
        if (!cancelled) setState({ loading: false, error: e as Error });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [discovery, fetchApi, entityRef]);

  if (state.loading) return <Progress />;
  if (state.error) {
    return (
      <EmptyState
        missing="info"
        title="Could not load DevOps Agent incidents"
        description={state.error.message}
      />
    );
  }
  if (state.data && !state.data.configured) {
    return (
      <EmptyState
        missing="info"
        title="DevOps Agent not configured"
        description="Set spec.observability.devopsAgent.agentSpaceId in platform.yaml to enable incident/RCA surfacing."
      />
    );
  }
  const incidents = state.data?.incidents ?? [];
  if (!incidents.length) {
    return (
      <EmptyState
        missing="data"
        title="No incidents"
        description="No DevOps Agent investigations match this entity's devops-agent-tags."
      />
    );
  }

  const columns: TableColumn<DevOpsAgentIncident>[] = [
    {
      title: 'Title',
      field: 'title',
      render: row => (row.url ? <Link to={row.url}>{row.title}</Link> : row.title),
    },
    { title: 'Type', field: 'taskType' },
    { title: 'Priority', field: 'priority', render: row => severityStatus(row.priority) },
    { title: 'Status', field: 'status' },
    { title: 'Created', field: 'createdAt' },
  ];

  return (
    <Table
      title={`DevOps Agent investigations (${incidents.length})`}
      columns={columns}
      data={incidents}
      options={{ search: true, paging: incidents.length > 10, padding: 'dense' }}
    />
  );
};

/** Whether the entity opts into the Incidents tab (has the annotation). */
export function isDevOpsAgentAvailable(entity: {
  metadata?: { annotations?: Record<string, string> };
}): boolean {
  return Boolean(entity?.metadata?.annotations?.[DEVOPS_AGENT_TAGS_ANNOTATION]);
}
