import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  IconButton,
  Paper,
  TextField,
  Typography,
  makeStyles,
} from '@material-ui/core';
import SendIcon from '@material-ui/icons/Send';
import RefreshIcon from '@material-ui/icons/Refresh';
import { useEntity } from '@backstage/plugin-catalog-react';
import {
  useApi,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import {
  Progress,
  EmptyState,
  Link,
  StatusOK,
  StatusError,
  StatusPending,
} from '@backstage/core-components';
import {
  AgentSpaceInfo,
  ChatMessage,
  ChatMessageReference,
  ChatSession,
  CreateChatResponse,
  DEVOPS_AGENT_TAGS_ANNOTATION,
  ListMessagesResponse,
  SendMessageResponse,
} from '@internal/plugin-devops-agent-common';

/**
 * Chat tab content. Genai-style entity surface for the AWS DevOps Agent
 * plugin. Modeled on awslabs/backstage-plugins-for-aws/plugins/genai.
 *
 * Lifecycle (matches the SDK's actual semantics):
 *   1. On mount, GET /api/devops-agent/agentspace?entityRef=... to resolve or
 *      lazily create the agentSpace for this entity (CreateAgentSpace).
 *   2. The user clicks "Start chat" -> POST /chats which calls CreateChat
 *      and returns an `executionId`. We persist {executionId, agentSpaceId}
 *      client-side so a tab reload can replay messages.
 *   3. Each user input -> POST /chats/:executionId/messages -> SendMessage
 *      kicks off an async agent response. The backend polls
 *      ListPendingMessages briefly; if the assistant's reply lands within
 *      ~25s we render it inline, otherwise we mark the row "pending" and
 *      keep polling /messages.
 *   4. On tab reload we refresh /messages so any reply that arrived while
 *      the user was away is restored (best effort - SDK has no full chat
 *      history, only currently-pending messages).
 *
 * The agentSpace deep link in the header lets developers escalate from the
 * Backstage chat into the DevOps Agent web app for the full Journal /
 * Recommendations / Execution graph view.
 */

const useStyles = makeStyles(theme => ({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: 'calc(100vh - 220px)',
    minHeight: 480,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: theme.spacing(1),
    gap: theme.spacing(1),
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
  },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: theme.spacing(2),
    background: theme.palette.background.default,
    borderRadius: theme.shape.borderRadius,
    marginBottom: theme.spacing(1),
  },
  bubble: {
    padding: theme.spacing(1.25, 1.75),
    borderRadius: theme.shape.borderRadius,
    margin: theme.spacing(0.75, 0),
    maxWidth: '78%',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  user: {
    background: theme.palette.primary.main,
    color: theme.palette.primary.contrastText,
    marginLeft: 'auto',
    borderTopRightRadius: 4,
  },
  assistant: {
    background: theme.palette.background.paper,
    border: `1px solid ${theme.palette.divider}`,
    marginRight: 'auto',
    borderTopLeftRadius: 4,
  },
  system: {
    background: theme.palette.background.paper,
    fontStyle: 'italic',
    color: theme.palette.text.secondary,
    marginRight: 'auto',
  },
  pending: {
    background: theme.palette.background.paper,
    border: `1px dashed ${theme.palette.divider}`,
    color: theme.palette.text.secondary,
    fontStyle: 'italic',
    marginRight: 'auto',
  },
  refs: {
    marginTop: theme.spacing(0.5),
    fontSize: '0.75rem',
  },
  composer: {
    display: 'flex',
    gap: theme.spacing(1),
    alignItems: 'flex-end',
  },
  composerInput: {
    flex: 1,
  },
}));

interface ChatStorage {
  executionId: string;
  agentSpaceId: string;
}

const storageKey = (entityRef: string) =>
  `fleet.devops-agent.chat:${entityRef}`;

function loadStoredChat(entityRef: string): ChatStorage | undefined {
  try {
    const raw = window.localStorage.getItem(storageKey(entityRef));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (parsed?.executionId && parsed?.agentSpaceId) {
      return parsed as ChatStorage;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function storeChat(entityRef: string, value: ChatStorage | undefined) {
  try {
    if (!value) {
      window.localStorage.removeItem(storageKey(entityRef));
    } else {
      window.localStorage.setItem(storageKey(entityRef), JSON.stringify(value));
    }
  } catch {
    /* ignore */
  }
}

function statusBadge(status: AgentSpaceInfo['status']) {
  if (status === 'READY') return <StatusOK>Ready</StatusOK>;
  if (status === 'ERROR') return <StatusError>Error</StatusError>;
  if (status === 'PROVISIONING') return <StatusPending>Provisioning</StatusPending>;
  return <StatusPending>Not configured</StatusPending>;
}

const PENDING_POLL_MS = 3000;

export const ChatContent = () => {
  const classes = useStyles();
  const { entity } = useEntity();
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);

  const entityRef = `${entity.kind.toLowerCase()}:${
    entity.metadata.namespace ?? 'default'
  }/${entity.metadata.name}`;

  const [agentSpace, setAgentSpace] = useState<AgentSpaceInfo>({
    status: 'PROVISIONING',
  });
  const [chat, setChat] = useState<ChatSession | undefined>(undefined);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /** ids of pending user messages waiting for a reply. */
  const [pendingUserIds, setPendingUserIds] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const messagesRef = useRef<HTMLDivElement | null>(null);

  const apiBase = useCallback(
    () => discovery.getBaseUrl('devops-agent'),
    [discovery],
  );

  /** Step 1: resolve the agentSpace; may lazily create it server-side. */
  const resolveAgentSpace = useCallback(async () => {
    setAgentSpace({ status: 'PROVISIONING' });
    setError(undefined);
    try {
      const base = await apiBase();
      const resp = await fetchApi.fetch(
        `${base}/agentspace?entityRef=${encodeURIComponent(entityRef)}`,
      );
      if (!resp.ok) throw new Error(`agentspace lookup ${resp.status}`);
      const info = (await resp.json()) as AgentSpaceInfo;
      setAgentSpace(info);
      return info;
    } catch (e: any) {
      setAgentSpace({ status: 'ERROR', message: e?.message ?? String(e) });
      return undefined;
    }
  }, [apiBase, fetchApi, entityRef]);

  /** Step 2 (deferred): replay messages from a previously stored chat. */
  const replayChat = useCallback(
    async (stored: ChatStorage) => {
      try {
        const base = await apiBase();
        const resp = await fetchApi.fetch(
          `${base}/chats/${encodeURIComponent(
            stored.executionId,
          )}/messages?agentSpaceId=${encodeURIComponent(stored.agentSpaceId)}`,
        );
        if (!resp.ok) {
          // Discard stale stored chat (e.g. agent rotated the executionId).
          storeChat(entityRef, undefined);
          return;
        }
        const data = (await resp.json()) as ListMessagesResponse;
        setChat({
          executionId: stored.executionId,
          agentSpaceId: stored.agentSpaceId,
          entityRef,
        });
        setMessages(data.messages);
      } catch {
        storeChat(entityRef, undefined);
      }
    },
    [apiBase, fetchApi, entityRef],
  );

  // On mount: resolve agentSpace, then optionally replay a stored chat.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const info = await resolveAgentSpace();
      if (cancelled) return;
      if (info?.status === 'READY') {
        const stored = loadStoredChat(entityRef);
        if (stored && stored.agentSpaceId === info.agentSpaceId) {
          await replayChat(stored);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resolveAgentSpace, replayChat, entityRef]);

  // Auto-scroll on new message.
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages.length]);

  // Background polling: while we have any pending user messages, refresh the
  // pending-messages list every PENDING_POLL_MS so late agent replies land
  // even after our SendMessage call timed out.
  useEffect(() => {
    if (!chat || pendingUserIds.size === 0) return undefined;
    let cancelled = false;
    const interval = window.setInterval(async () => {
      if (cancelled) return;
      try {
        const base = await apiBase();
        const resp = await fetchApi.fetch(
          `${base}/chats/${encodeURIComponent(
            chat.executionId,
          )}/messages?agentSpaceId=${encodeURIComponent(chat.agentSpaceId)}`,
        );
        if (!resp.ok) return;
        const data = (await resp.json()) as ListMessagesResponse;
        // Merge any *new* assistant messages we don't already have.
        setMessages(prev => {
          const have = new Set(prev.map((m: ChatMessage) => m.id));
          const additions = data.messages.filter(
            (m: ChatMessage) => m.role === 'assistant' && !have.has(m.id),
          );
          if (additions.length === 0) return prev;
          // Clear pending markers when at least one assistant reply arrives.
          setPendingUserIds(new Set());
          return [...prev, ...additions];
        });
      } catch {
        /* keep polling */
      }
    }, PENDING_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [chat, pendingUserIds, apiBase, fetchApi]);

  /** Open a fresh chat for this entity. */
  const startChat = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const base = await apiBase();
      const resp = await fetchApi.fetch(`${base}/chats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityRef }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`createChat ${resp.status}: ${body}`);
      }
      const data = (await resp.json()) as CreateChatResponse;
      setChat(data.chat);
      setMessages(data.welcome ? [data.welcome] : []);
      setPendingUserIds(new Set());
      storeChat(entityRef, {
        executionId: data.chat.executionId,
        agentSpaceId: data.chat.agentSpaceId,
      });
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [apiBase, fetchApi, entityRef]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || !chat) return;
    setBusy(true);
    setError(undefined);
    // Optimistic echo of the user message; we'll replace its id when the
    // server returns the canonical SendMessage response.
    const optimisticId = `pending-${Date.now()}`;
    const optimistic: ChatMessage = {
      id: optimisticId,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    };
    setMessages(prev => [...prev, optimistic]);
    setDraft('');
    try {
      const base = await apiBase();
      const resp = await fetchApi.fetch(
        `${base}/chats/${encodeURIComponent(chat.executionId)}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentSpaceId: chat.agentSpaceId,
            content: text,
          }),
        },
      );
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`sendMessage ${resp.status}: ${body}`);
      }
      const data = (await resp.json()) as SendMessageResponse;
      setMessages(prev => {
        const without = prev.filter(m => m.id !== optimisticId);
        const next = [...without, data.userMessage];
        if (data.reply) next.push(data.reply);
        return next;
      });
      if (data.pending && !data.reply) {
        // Mark this user message as awaiting a reply so the polling effect
        // picks up the assistant message when it lands.
        setPendingUserIds(prev => {
          const out = new Set(prev);
          out.add(data.userMessage.id);
          return out;
        });
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setMessages(prev => prev.filter(m => m.id !== optimisticId));
    } finally {
      setBusy(false);
    }
  }, [draft, chat, apiBase, fetchApi]);

  const onComposerKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!busy) send();
      }
    },
    [busy, send],
  );

  // ---------- render ----------

  if (agentSpace.status === 'NOT_CONFIGURED') {
    return (
      <EmptyState
        missing="info"
        title="DevOps Agent not configured"
        description={
          agentSpace.message ??
          `Set spec.observability.devopsAgent.enabled: true in platform.yaml. The plugin will provision an agentSpace on first use via CreateAgentSpace.`
        }
      />
    );
  }
  if (agentSpace.status === 'PROVISIONING' && messages.length === 0 && !chat) {
    return <Progress />;
  }

  const tags = entity.metadata.annotations?.[DEVOPS_AGENT_TAGS_ANNOTATION];
  const replyPending = pendingUserIds.size > 0;

  return (
    <Paper className={classes.root} elevation={0}>
      <div className={classes.header}>
        <div className={classes.headerLeft}>
          <Typography variant="subtitle1">DevOps Agent</Typography>
          {statusBadge(agentSpace.status)}
          {agentSpace.url && (
            <Link to={agentSpace.url}>open in console</Link>
          )}
        </div>
        <div>
          <IconButton
            size="small"
            title="Refresh"
            onClick={() => resolveAgentSpace()}
            disabled={busy}
          >
            <RefreshIcon fontSize="small" />
          </IconButton>
          {!chat && (
            <Button
              variant="contained"
              color="primary"
              size="small"
              onClick={startChat}
              disabled={busy || agentSpace.status !== 'READY'}
            >
              {busy ? 'Starting…' : 'Start chat'}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <Typography color="error" variant="body2" gutterBottom>
          {error}
        </Typography>
      )}

      <div className={classes.messages} ref={messagesRef}>
        {!chat && (
          <Typography variant="body2" color="textSecondary">
            Start a chat to ask the agent about <code>{entityRef}</code>
            {tags ? <> (tags: <code>{tags}</code>)</> : null}.
          </Typography>
        )}
        {messages.map(m => (
          <div
            key={m.id}
            className={`${classes.bubble} ${
              m.role === 'user'
                ? classes.user
                : m.role === 'system'
                  ? classes.system
                  : classes.assistant
            }`}
          >
            <div>{m.content}</div>
            {m.references && m.references.length > 0 && (
              <div className={classes.refs}>
                {m.references.map(
                  (r: ChatMessageReference, i: number) => (
                    <span key={i}>
                      {i > 0 ? ' · ' : ''}
                      {r.url ? <Link to={r.url}>{r.title}</Link> : r.title}
                      {r.kind ? <> ({r.kind})</> : null}
                    </span>
                  ),
                )}
              </div>
            )}
          </div>
        ))}
        {replyPending && (
          <div className={`${classes.bubble} ${classes.pending}`}>
            Agent is thinking…
          </div>
        )}
      </div>

      <div className={classes.composer}>
        <TextField
          className={classes.composerInput}
          variant="outlined"
          size="small"
          multiline
          minRows={1}
          maxRows={6}
          placeholder={
            chat
              ? 'Ask the DevOps Agent anything about this workload…'
              : 'Start a chat first'
          }
          value={draft}
          disabled={!chat || busy}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onComposerKey}
        />
        <Button
          variant="contained"
          color="primary"
          endIcon={<SendIcon />}
          onClick={send}
          disabled={!chat || !draft.trim() || busy}
        >
          Send
        </Button>
      </div>
    </Paper>
  );
};

/** Whether the entity opts into the DevOps Agent chat tab. */
export function isDevOpsAgentAvailable(entity: {
  metadata?: { annotations?: Record<string, string> };
}): boolean {
  return Boolean(entity?.metadata?.annotations?.[DEVOPS_AGENT_TAGS_ANNOTATION]);
}
