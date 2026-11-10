/**
 * The Assistant's server calls: provider status, keys, and the chat stream.
 *
 * The page never holds an API key: it sends one once (PUT /assistant/key), the
 * server keeps it on this computer, and the chat goes through the server's relay
 * (POST /assistant/chat), which streams server-sent events back. The server runs
 * Bowser's data tools itself; it stops with `page_tools` when the model asks for
 * a tool only the page can run (see ./pageTools).
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

export interface AssistantStatus {
  enabled: boolean;
  page_keys: boolean;
  providers: ProviderInfo[];
  default_provider: string | null;
  stored_in?: string | null;
}

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
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown>; runs: 'server' }
  | { type: 'tool_result'; id: string; name: string; input: Record<string, unknown>; ok: boolean; result: unknown }
  | { type: 'page_tools'; calls: ToolCall[]; results: ToolResult[] }
  | { type: 'error'; kind: string; message: string }
  | { type: 'done'; stop: 'end' | 'max_tokens' | 'refusal' | 'page_tools' | 'max_steps'; detail?: string };

export interface PageToolSpec { name: string; description: string; input_schema: Record<string, unknown> }

export interface ChatRequest {
  provider: string;
  model: string;
  messages: ConvMessage[];
  page_tools: PageToolSpec[];
  dataset: string | null;
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
