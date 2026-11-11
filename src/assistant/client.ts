/**
 * The Assistant's server calls: provider status, keys, and the chat stream.
 *
 * The page never holds an API key: it sends one once (PUT /assistant/key), the
 * server keeps it on this computer, and the chat goes through the server's relay
 * (POST /assistant/chat), which streams server-sent events back. The server runs
 * Bowser's data tools itself; it stops with `page_tools` when the model asks for
 * a tool only the page can run (see ./pageTools).
 *
 * Signing in (POST /assistant/signin) replaces the key with an account: ChatGPT
 * (OAuth; the tokens stay on the server) or Claude, whose own Claude Code answers
 * through the server and asks the page before it runs a tool (`permission`).
 */

export interface ProviderInfo {
  id: string;
  label: string;
  wire: 'anthropic' | 'openai' | 'gemini' | 'responses';
  model: string;
  models: string[];
  needs_key: boolean;
  local: boolean;
  auth: 'api_key' | 'none' | 'sign_in';
  available: boolean;
  note: string;
  key_url: string;
  configured: boolean;
  source: 'saved' | 'environment' | null;
  hint: string | null;
  store: 'keyring' | 'file' | null;
}

/** One way to sign in (src/bowser/assistant/signin.py), with its state on this server. */
export interface SignInMethod {
  id: string;
  label: string;
  kind: 'oauth' | 'local_agent';
  vendor: string;
  blurb: string;
  state: 'signed_out' | 'pending' | 'signed_in' | 'no_plan' | 'not_installed';
  account: string | null;
  plan: string | null;
  detail: string | null;
  install_url: string | null;
  usage_url: string | null;
  model: string;
  models: string[];
}

export interface SignInStatus {
  /** False on a shared server or from another computer; `reason` says why. */
  allowed: boolean;
  reason: string | null;
  methods: SignInMethod[];
}

export interface AssistantStatus {
  enabled: boolean;
  page_keys: boolean;
  providers: ProviderInfo[];
  default_provider: string | null;
  stored_in?: string | null;
  sign_in: SignInStatus;
  sign_in_url?: string | null;
  note?: string | null;
}

/** A model in a provider's own list (GET /assistant/models). */
export interface ModelInfo { id: string; label: string | null }
export interface ModelList { provider: string; models: ModelInfo[]; cached: boolean }

export interface ToolCall { id: string; name: string; input: Record<string, unknown> }
export interface ToolResult { id: string; name: string; content: string; is_error: boolean }

/** The conversation, as the server's providers read it (src/bowser/assistant/providers.py). */
export type ConvMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[]; native?: unknown }
  | { role: 'tool'; results: ToolResult[] };

export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'message'; message: ConvMessage }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown>; runs: 'server' | 'agent' }
  | { type: 'tool_result'; id: string; name: string; input: Record<string, unknown>; ok: boolean; result: unknown }
  | { type: 'page_tools'; calls: ToolCall[]; results: ToolResult[] }
  | { type: 'error'; kind: string; message: string; code?: string }
  | { type: 'done'; stop: 'end' | 'max_tokens' | 'refusal' | 'page_tools' | 'max_steps' | 'cancelled'; detail?: string }
  /** A signed-in agent: what it is doing, and its requests to run a tool. */
  | { type: 'status'; text: string; phase?: AgentPhase; elapsed?: number }
  | { type: 'permission'; id: string; name: string; title: string; detail: string; options: { kind: string; name: string }[]; timeout: number }
  | { type: 'permission_closed'; id: string; outcome: string };

export interface PageToolSpec { name: string; description: string; input_schema: Record<string, unknown> }

export interface ChatRequest {
  provider: string;
  model: string;
  messages: ConvMessage[];
  page_tools: PageToolSpec[];
  dataset: string | null;
  /** This chat's id: keeps a signed-in agent's session between questions. */
  conversation?: string;
}

/** A refusal from the relay itself (HTTP status and its detail), before any streaming. */
export class RelayError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new RelayError(res.status, String((body as { detail?: unknown }).detail ?? `HTTP ${res.status}`));
  return body as T;
}

export async function fetchStatus(): Promise<AssistantStatus> {
  return json(await fetch('/assistant/status', { cache: 'no-store' }));
}

/** The provider's live model list, asked for on the server with its key; `refresh` skips the server's cache. */
export async function fetchModels(provider: string, refresh = false): Promise<ModelList> {
  const q = `provider=${encodeURIComponent(provider)}${refresh ? '&refresh=true' : ''}`;
  return json(await fetch(`/assistant/models?${q}`, { cache: 'no-store' }));
}

/** Check a key with its provider and keep it on this computer. */
export async function saveKey(provider: string, key: string): Promise<AssistantStatus> {
  return json(await fetch('/assistant/key', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, key }),
  }));
}

export async function removeKey(provider: string): Promise<AssistantStatus> {
  return json(await fetch(`/assistant/key?provider=${encodeURIComponent(provider)}`, { method: 'DELETE' }));
}

/** Start signing in; for ChatGPT, `sign_in_url` is OpenAI's page to open. */
export async function signIn(method: string, consent = false): Promise<AssistantStatus> {
  return json(await fetch('/assistant/signin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, ...(consent ? { consent: true } : {}) }),
  }));
}

export async function signOut(method: string): Promise<AssistantStatus> {
  return json(await fetch(`/assistant/signin?method=${encodeURIComponent(method)}`, { method: 'DELETE' }));
}

/** Answer a signed-in agent's request to run a tool. */
export async function answerPermission(conversation: string, id: string, choice: 'allow' | 'allow_always' | 'reject'): Promise<void> {
  await json(await fetch('/assistant/permission', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation, id, choice }),
  }));
}

export type AgentPhase = 'none' | 'installing' | 'starting' | 'ready' | 'error';

/** How far a chat's signed-in agent has started (GET/POST /assistant/agent). */
export interface AgentState {
  phase: AgentPhase;
  text: string;
  /** Seconds since the start (to ready, once ready). */
  elapsed: number;
  error: string | null;
  /** Set when npx stands in for the installed adapter (slower). */
  note: string | null;
}

/** Start a chat's agent now, before its first question. */
export async function startAgent(conversation: string): Promise<AgentState> {
  return json(await fetch('/assistant/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation }),
  }));
}

export async function fetchAgentState(conversation: string): Promise<AgentState> {
  return json(await fetch(`/assistant/agent?conversation=${encodeURIComponent(conversation)}`, { cache: 'no-store' }));
}

/** Stop a chat's agent (its process is killed); errors are ignored. */
export async function stopAgent(conversation: string): Promise<void> {
  await fetch('/assistant/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation }),
  }).catch(() => undefined);
}

/** Send the conversation; call `onEvent` for each server-sent event until the stream ends. */
export async function streamChat(body: ChatRequest, onEvent: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch('/assistant/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const detail = await res.json().then((j: { detail?: unknown }) => j.detail).catch(() => null);
    throw new RelayError(res.status, String(detail ?? `HTTP ${res.status}`));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (block: string) => {
    const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (data) onEvent(JSON.parse(data) as ChatEvent);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      flush(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
    }
  }
  if (buffer.trim()) flush(buffer);
}
