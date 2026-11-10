import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAppContext } from '../../context/AppContext';
import { useApi } from '../../hooks/useApi';
import {
  fetchStatus, removeKey, saveKey, streamChat, RelayError,
  type AssistantStatus, type ChatEvent, type ConvMessage, type ProviderInfo, type ToolResult,
} from '../../assistant/client';
import { newDone, PAGE_TOOL_NAMES, PAGE_TOOLS, pageState, runPageTool, showResult, type PageContext } from '../../assistant/pageTools';
import { SectionHeader } from './controls';

const PREFS_KEY = 'bowser-assistant';
const MCP_DOCS = 'https://github.com/opera-adt/bowser/blob/main/docs/mcp.md';
/** Requests per question: each ends with an answer or with page tools to run. */
const MAX_ROUNDS = 8;

interface Prefs { provider?: string; models?: Record<string, string> }

function readPrefs(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function savePrefs(p: Prefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* this page only */ }
}

type Entry =
  | { kind: 'user' | 'assistant' | 'note'; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; state: 'running' | 'ok' | 'error'; where: 'server' | 'page' }
  | { kind: 'error'; text: string };

/** Escape-free inline markdown: **bold**, `code`, [links](https://…). */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<strong key={m.index}>{m[1]}</strong>);
    else if (m[2]) out.push(<code key={m.index}>{m[2]}</code>);
    else out.push(<a key={m.index} href={m[4]} target="_blank" rel="noopener noreferrer">{m[3]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Markdown({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {inline(line.replace(/^\s*[-*] /, '• '))}
        </Fragment>
      ))}
    </>
  );
}

/** A tool call in one line: its name and the first few arguments. */
function callText(name: string, input: Record<string, unknown>): string {
  const args = Object.entries(input).filter(([k]) => k !== 'dataset')
    .map(([k, v]) => `${k} ${typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : JSON.stringify(v)}`).join(', ');
  return `${name}(${args.length > 70 ? `${args.slice(0, 70)}…` : args})`;
}

const ERRORS: Record<string, string> = {
  auth: 'The provider did not accept the API key. Check it under Provider and key.',
  rate_limit: "The provider's rate limit was reached. Wait a moment and ask again.",
  provider_down: 'The provider could not be reached or is overloaded. Try again shortly.',
  bad_response: 'The provider sent an answer that could not be read. Ask again.',
};

/** A chat with the user's own AI provider, answered with Bowser's tools (see src/bowser/assistant). */
export default function AssistantTab() {
  const { state, dispatch } = useAppContext();
  const { fetchPointTimeSeries, fetchBufferTimeSeries, currentDatasetId } = useApi();
  const stateRef = useRef(state);
  stateRef.current = state;

  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);
  const [setupOpen, setSetupOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyMsg, setKeyMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  const [entries, setEntries] = useState<Entry[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const history = useRef<ConvMessage[]>([]);
  const abort = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // Read the providers once the tab is first shown.
  const shown = state.panelTab === 'assistant';
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!shown || asked) return;
    setAsked(true);
    fetchStatus().then(s => {
      setStatus(s);
      if (s.enabled && !s.providers.some(p => p.available && p.configured)) setSetupOpen(true);
    }).catch(e => setStatusError((e as Error).message));
  }, [shown, asked]);

  useEffect(() => {
    logRef.current?.scrollTo?.({ top: logRef.current.scrollHeight });
  }, [entries, working]);

  const providers = status?.providers ?? [];
  const chosenId = providers.some(p => p.id === prefs.provider && p.available) ? prefs.provider!
    : status?.default_provider ?? providers.find(p => p.available && p.configured)?.id ?? providers.find(p => p.available)?.id ?? '';
  const provider: ProviderInfo | undefined = providers.find(p => p.id === chosenId);
  const model = (provider && prefs.models?.[provider.id]) ?? provider?.model ?? '';
  const ready = Boolean(provider?.available && provider.configured && model);

  const choose = (id: string) => {
    const next = { ...prefs, provider: id };
    setPrefs(next);
    savePrefs(next);
    setKeyDraft('');
    setKeyMsg(null);
  };
  const setModel = (m: string) => {
    if (!provider) return;
    const next = { ...prefs, models: { ...prefs.models, [provider.id]: m } };
    setPrefs(next);
    savePrefs(next);
  };

  const save = async () => {
    if (!provider) return;
    const key = keyDraft.trim();
    if (!key) return setKeyMsg({ text: `Paste your ${provider.label} API key.`, error: true });
    setSaving(true);
    setKeyMsg({ text: `Checking with ${provider.label}…` });
    try {
      const s = await saveKey(provider.id, key);
      setStatus(s);
      setKeyMsg({ text: `Saved on this computer (${s.stored_in ?? 'the server'}).` });
    } catch (e) {
      setKeyMsg({ text: `Not saved: ${(e as Error).message}`, error: true });
    } finally {
      setKeyDraft(''); // never kept in the page
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!provider) return;
    try {
      setStatus(await removeKey(provider.id));
      setKeyMsg({ text: 'Removed.' });
    } catch (e) {
      setKeyMsg({ text: `Could not remove: ${(e as Error).message}`, error: true });
    }
  };

  const add = (e: Entry) => setEntries(list => [...list, e]);
  const appendText = (text: string) => setEntries(list => {
    const last = list[list.length - 1];
    if (last?.kind === 'assistant') return [...list.slice(0, -1), { ...last, text: last.text + text }];
    return [...list, { kind: 'assistant', text }];
  });
  const setTool = (id: string, s: 'ok' | 'error') =>
    setEntries(list => list.map(e => (e.kind === 'tool' && e.id === id ? { ...e, state: s } : e)));

  const ask = useCallback(async () => {
    const text = question.trim();
    if (!text || busy || !provider || !ready) return;
    const ctx: PageContext = {
      getState: () => stateRef.current,
      dispatch,
      api: { fetchPointTimeSeries, fetchBufferTimeSeries },
      done: newDone(),
    };
    const dataset = currentDatasetId();
    const before = history.current.length;
    history.current.push({ role: 'user', content: `[page: ${JSON.stringify(pageState(stateRef.current, dataset))}]\n\n${text}` });
    setQuestion('');
    add({ kind: 'user', text });
    setBusy(true);
    setWorking('Thinking…');
    const controller = new AbortController();
    abort.current = controller;
    let failed = false;
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        let waiting: { calls: { id: string; name: string; input: Record<string, unknown> }[]; results: ToolResult[] } | null = null;
        let stop = '';
        let detail = '';
        await streamChat(
          { provider: provider.id, model, messages: history.current, page_tools: PAGE_TOOLS, dataset },
          (ev: ChatEvent) => {
            switch (ev.type) {
              case 'text': setWorking(null); appendText(ev.text); break;
              case 'message':
                history.current.push(ev.message);
                if (ev.message.role === 'assistant') setEntries(l => [...l, { kind: 'note', text: '' }]);
                break;
              case 'tool_call':
                setWorking('Reading the data…');
                add({ kind: 'tool', id: ev.id, name: ev.name, input: ev.input, state: 'running', where: 'server' });
                break;
              case 'tool_result':
                setTool(ev.id, ev.ok ? 'ok' : 'error');
                if (ev.ok) showResult(ev.name, ev.input, ctx);
                break;
              case 'page_tools': waiting = { calls: ev.calls, results: ev.results }; break;
              case 'error': failed = true; add({ kind: 'error', text: `${ERRORS[ev.kind] ?? ''} ${ev.message}`.trim() }); break;
              case 'done': stop = ev.stop; detail = ev.detail ?? ''; break;
            }
          },
          controller.signal,
        );
        if (failed) break;
        if (stop === 'refusal') add({ kind: 'note', text: `The model declined this request${detail ? ` (${detail})` : ''}.` });
        if (stop === 'max_tokens') add({ kind: 'note', text: 'The answer hit its length limit.' });
        if (stop === 'max_steps') add({ kind: 'note', text: 'Stopped after many tool calls; ask again to continue.' });
        if (stop !== 'page_tools' || !waiting) break;
        // The page's turn: run its tools, then send every result back in one message.
        setWorking('Working on the map…');
        const { calls, results } = waiting as { calls: { id: string; name: string; input: Record<string, unknown> }[]; results: ToolResult[] };
        const done: ToolResult[] = [...results];
        for (const call of calls) {
          add({ kind: 'tool', id: call.id, name: call.name, input: call.input, state: 'running', where: 'page' });
          let content: string;
          let ok = PAGE_TOOL_NAMES.has(call.name);
          try {
            content = JSON.stringify(await runPageTool(call.name, call.input, ctx));
          } catch (e) {
            ok = false;
            content = (e as Error).message;
          }
          setTool(call.id, ok ? 'ok' : 'error');
          done.push({ id: call.id, name: call.name, content, is_error: !ok });
        }
        const last = history.current[history.current.length - 1];
        const order = last?.role === 'assistant' ? (last.tool_calls ?? []).map(c => c.id) : [];
        done.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        history.current.push({ role: 'tool', results: done });
        setWorking('Thinking…');
      }
    } catch (e) {
      failed = true;
      if ((e as Error).name === 'AbortError') add({ kind: 'note', text: 'Stopped.' });
      else if (e instanceof RelayError) add({ kind: 'error', text: e.message });
      else add({ kind: 'error', text: `Could not reach the Bowser server: ${(e as Error).message}` });
    } finally {
      // An unfinished exchange is dropped, so the next question starts clean.
      if (failed) history.current.length = before;
      abort.current = null;
      setBusy(false);
      setWorking(null);
    }
  }, [question, busy, provider, ready, model, dispatch, fetchPointTimeSeries, fetchBufferTimeSeries, currentDatasetId]);

  const newChat = () => {
    if (busy) return;
    history.current = [];
    setEntries([]);
  };

  if (statusError) {
    return (
      <div className="sidebar-section">
        <SectionHeader label="Assistant" />
        <div className="row-label ai-error" role="alert">Could not ask the server about the Assistant: {statusError}</div>
      </div>
    );
  }
  if (!status) {
    return <div className="sidebar-section"><SectionHeader label="Assistant" /><div className="row-label">Checking…</div></div>;
  }
  if (!status.enabled) {
    return (
      <div className="sidebar-section">
        <SectionHeader label="Assistant" />
        <p className="ai-note">The Assistant is off on this server.</p>
        <p className="row-label ai-small">
          It is on when you run Bowser on your own computer (<code>bowser run</code>, <code>bowser lite</code> or the desktop
          app). On a shared server, its administrator turns it on with <code>BOWSER_ASSISTANT=1</code> and a key for the
          server.
        </p>
        <SubscriptionNote />
      </div>
    );
  }

  const keyed = provider?.source === 'saved';
  return (
    <>
      <div className="sidebar-section">
        <SectionHeader label="Provider and key" collapsed={!setupOpen} onToggle={() => setSetupOpen(o => !o)} />
        {!setupOpen && provider && (
          <div className="row-label ai-small">
            {provider.label} · {model || 'no model'} · {provider.configured ? (provider.needs_key ? (keyed ? `key ${provider.hint ?? 'saved'}` : 'server key') : 'no key needed') : 'no key yet'}
          </div>
        )}
        {setupOpen && (
          <>
            <label className="ai-field">
              <span className="minmax-label">Provider</span>
              <select aria-label="Provider" className="sidebar-select" value={chosenId} onChange={e => choose(e.target.value)}>
                {providers.map(p => (
                  <option key={p.id} value={p.id} disabled={!p.available}>
                    {p.label}{p.available ? '' : ` (${p.note.replace(/\.$/, '').toLowerCase() || 'later'})`}
                  </option>
                ))}
              </select>
            </label>
            {provider && (
              <label className="ai-field">
                <span className="minmax-label">Model</span>
                <input aria-label="Model" className="sidebar-input ai-text" list="ai-models" value={model}
                  placeholder={provider.local ? 'Model name, e.g. qwen3' : ''} onChange={e => setModel(e.target.value.trim())} />
                <datalist id="ai-models">{provider.models.map(m => <option key={m} value={m} />)}</datalist>
              </label>
            )}
            {provider && provider.auth === 'api_key' && status.page_keys && (
              keyed ? (
                <div className="ai-saved">
                  <span className="row-label">Saved on this computer ({provider.hint})</span>
                  <button type="button" className="hist-btn ai-inline-btn" onClick={remove}>Remove</button>
                </div>
              ) : (
                <label className="ai-field">
                  <span className="minmax-label">API key</span>
                  <input aria-label="API key" className="sidebar-input ai-text" type="password" autoComplete="off" spellCheck={false}
                    placeholder={provider.source === 'environment' ? 'Using the key from the environment' : 'Paste your key'}
                    value={keyDraft} onChange={e => setKeyDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void save(); }} />
                </label>
              )
            )}
            {provider && status.page_keys && !keyed && provider.auth === 'api_key' && (
              <button type="button" className="hist-btn" disabled={saving || !keyDraft.trim()} onClick={save}>
                Check and save
              </button>
            )}
            {keyMsg && <div className={`row-label ai-small${keyMsg.error ? ' ai-error' : ''}`} role={keyMsg.error ? 'alert' : 'status'}>{keyMsg.text}</div>}
            {provider && !status.page_keys && provider.auth === 'api_key' && (
              <div className="row-label ai-small">
                {provider.configured ? 'This server provides the key.' : "Keys are set by this server's administrator."}
              </div>
            )}
            {provider && status.page_keys && provider.auth === 'api_key' && !keyed && (
              <div className="row-label ai-small">
                The key is checked with {provider.label} and kept on this computer (system keychain or a private file), never in the
                browser. Use is billed to your {provider.label} account.{' '}
                {provider.key_url && <a href={provider.key_url} target="_blank" rel="noopener noreferrer">Get a key</a>}
              </div>
            )}
            {provider?.local && (
              <div className="row-label ai-small">
                A model on your own computer or network: no key, nothing leaves it.{' '}
                {provider.key_url && <a href={provider.key_url} target="_blank" rel="noopener noreferrer">Get Ollama</a>}
              </div>
            )}
            <SubscriptionNote />
          </>
        )}
      </div>

      <div className="sidebar-section ai-chat">
        <SectionHeader label="Assistant" action={
          <button type="button" className="ov-icon-btn" onClick={newChat} disabled={busy || entries.length === 0}
            title="New chat" aria-label="New chat"><i className="fa-solid fa-pen-to-square" aria-hidden="true"></i></button>
        } />
        <div className="ai-log" ref={logRef} aria-live="polite">
          {entries.length === 0 && (
            <div className="row-label ai-small">
              Ask about the data on the map, for example “Is the area around the reference point stable?” or “Plot a
              point on the dam crest and give its trend.”
            </div>
          )}
          {entries.map((e, i) => {
            if (e.kind === 'tool') {
              return (
                <div key={i} className={`ai-tool ${e.state}`} title={e.where === 'page' ? 'On the page' : 'Read on the server'}>
                  <i className={`fa-solid ${e.state === 'running' ? 'fa-circle-notch fa-spin' : e.state === 'ok' ? (e.where === 'page' ? 'fa-map-location-dot' : 'fa-check') : 'fa-triangle-exclamation'}`} aria-hidden="true"></i>
                  <span>{callText(e.name, e.input)}</span>
                </div>
              );
            }
            if (e.kind === 'note' && !e.text) return null;
            if (e.kind === 'error') return <div key={i} className="ai-msg ai-error" role="alert">{e.text}</div>;
            return <div key={i} className={`ai-msg ai-${e.kind}`}><Markdown text={e.text} /></div>;
          })}
          {working && <div className="ai-working row-label" role="status"><span className="ai-spinner" aria-hidden="true" />{working}</div>}
        </div>
        <textarea aria-label="Question" className="sidebar-input ai-text ai-input" rows={3} value={question}
          placeholder={ready ? 'Ask about the data on the map…' : 'Choose a provider and add a key above'}
          disabled={!ready && !busy} onChange={e => setQuestion(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(); } }} />
        <div className="ai-row">
          <button type="button" className="hist-btn" onClick={newChat} disabled={busy || entries.length === 0}>New chat</button>
          {busy
            ? <button type="button" className="hist-btn ai-primary" onClick={() => abort.current?.abort()}>Stop</button>
            : <button type="button" className="hist-btn ai-primary" onClick={() => void ask()} disabled={!ready || !question.trim()}>Send</button>}
        </div>
        <div className="row-label ai-small">
          Answers come from satellite data and can be wrong: line-of-sight motion relative to a reference point and date.
          Confirm any finding with a qualified expert before acting on it.
        </div>
      </div>
    </>
  );
}

/** Claude Pro and Max plans cannot sign in here; Claude Code and Claude Desktop reach Bowser through MCP. */
function SubscriptionNote() {
  return (
    <div className="row-label ai-small">
      Have a Claude Pro or Max plan? It can't be used here, but Claude Code or Claude Desktop can work with Bowser through{' '}
      <code>bowser mcp</code>: <a href={MCP_DOCS} target="_blank" rel="noopener noreferrer">how to connect</a>.
    </div>
  );
}
