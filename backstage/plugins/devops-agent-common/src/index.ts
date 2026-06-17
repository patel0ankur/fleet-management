// Types + constants shared between the DevOps Agent frontend and backend
// plugins. Phase 5 redesign: the primary surface is an interactive chat
// (genai-style, modeled on awslabs/backstage-plugins-for-aws/plugins/genai).
// The DevOps Agent agentSpace is provisioned on-demand via CreateAgentSpace -
// no operator pre-step.
//
// IMPORTANT: the AWS DevOps Agent SDK names the chat session an
// "execution" (CreateChat returns an `executionId`, SendMessage takes one,
// ListPendingMessages takes one). We expose the same name on the wire so the
// frontend doesn't have to translate.

/**
 * Annotation that opts a catalog entity into the DevOps Agent chat tab.
 * Value is a comma-separated tag set, e.g. "service=hello,project=smoke-team".
 * The Fleet entity provider stamps this on every workload Component automatically.
 * An entity without this annotation does not show the tab.
 */
export const DEVOPS_AGENT_TAGS_ANNOTATION = 'aws.amazon.com/devops-agent-tags';

/**
 * Optional per-entity annotation that pins the chat to a specific
 * pre-existing agentSpace. When unset (the common case) the backend uses the
 * Fleet-default agentSpace, creating it lazily on first use.
 */
export const DEVOPS_AGENT_SPACE_ID_ANNOTATION = 'aws.amazon.com/devops-agent-space-id';

// ---------- AgentSpace ----------

/** Lifecycle state of the resolved agentSpace for a given entity. */
export type AgentSpaceStatus =
  | 'NOT_CONFIGURED' // backend has no AWS region / plugin disabled
  | 'PROVISIONING'   // CreateAgentSpace call in flight or async-pending
  | 'READY'          // resolved and usable
  | 'ERROR';

export interface AgentSpaceInfo {
  status: AgentSpaceStatus;
  agentSpaceId?: string;
  region?: string;
  /** Browser-openable link to the DevOps Agent web app for this agentSpace. */
  url?: string;
  /** Human-readable detail when status === 'ERROR' or 'NOT_CONFIGURED'. */
  message?: string;
}

// ---------- Chat ----------

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  /** Stable message id from the agent. */
  id: string;
  role: ChatRole;
  /** Plain-text body (concatenation of message blocks). */
  content: string;
  /** ISO timestamp. */
  createdAt?: string;
  /**
   * Optional structured citations the agent attached to this message
   * (Journal records, recommendations, log links). Rendered as a footer.
   */
  references?: ChatMessageReference[];
}

export interface ChatMessageReference {
  title: string;
  url?: string;
  /** e.g. "Journal", "Recommendation", "Execution". */
  kind?: string;
}

/**
 * A chat session. Backed by a DevOps Agent "chat execution" - the SDK calls
 * the unique id `executionId`, and we keep that name on the wire.
 */
export interface ChatSession {
  executionId: string;
  agentSpaceId: string;
  entityRef: string;
  createdAt?: string;
}

// ---------- Backend response shapes ----------

export interface CreateChatResponse {
  chat: ChatSession;
  /** Local welcome message generated server-side (the SDK has no welcome). */
  welcome?: ChatMessage;
}

export interface SendMessageResponse {
  /** The user message echoed back with its server-assigned id. */
  userMessage: ChatMessage;
  /** The agent's reply, if available within the polling window. */
  reply?: ChatMessage;
  /**
   * When the agent's reply is still pending after the polling window,
   * the frontend can keep polling /messages.
   */
  pending?: boolean;
}

export interface ListMessagesResponse {
  executionId: string;
  messages: ChatMessage[];
}
