import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAppContext } from '../../context/AppContext';
import { useApi } from '../../hooks/useApi';
import {
  answerPermission, fetchAgentState, fetchModels, startAgent, fetchStatus, removeKey, saveKey, signIn, signOut, stopAgent, streamChat, RelayError,
  type AgentState, type AssistantStatus, type ChatEvent, type ConvMessage, type ModelInfo, type ProviderInfo, type SignInMethod, type ToolResult,
} from '../../assistant/client';
import { newDone, PAGE_TOOL_NAMES, PAGE_TOOLS, pageState, runPageTool, showResult, toolStatus, type PageContext } from '../../assistant/pageTools';
import { SectionHeader } from './controls';

const PREFS_KEY = 'bowser-assistant';
const MCP_DOCS = 'https://github.com/opera-adt/bowser/blob/main/docs/mcp.md';
/** Requests per question: each ends with an answer or with page tools to run. */
const MAX_ROUNDS = 8;
/** While a sign-in waits for the provider's page, the tab asks the server this often. */
const POLL_MS = 2000;
const POLL_FOR_MS = 10 * 60 * 1000;

interface Prefs { provider?: string; models?: Record<string, string>; welcomed?: string[] }

/** The service's name in a sign-in button's text: "Sign in with Claude" → "Claude". */
const serviceName = (m: SignInMethod) => m.label.replace(/^(Sign in|Continue) with /, '');

const newConversation = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

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

type PermissionState = 'open' | 'allow' | 'allow_always' | 'reject' | 'timeout' | 'closed';

type Entry =
  | { kind: 'user' | 'assistant' | 'note'; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; state: 'running' | 'ok' | 'error'; where: 'server' | 'page' | 'agent'; started: number; ms?: number }
  | { kind: 'error'; text: string; link?: { href: string; text: string } }
  | { kind: 'permission'; id: string; name: string; title: string; detail: string; always: boolean; state: PermissionState };

/** Seconds for a status line or a tool's duration: "0.4 s", "12 s". */
function seconds(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
}

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
  const [keysOpen, setKeysOpen] = useState(false);
  const [signMsg, setSignMsg] = useState<{ text: string; error?: boolean } | null>(null);
  /** OpenAI's page, as a link, while a sign-in waits (the new tab may have been blocked or closed). */
  const [signUrl, setSignUrl] = useState<string | null>(null);
  const starting = useRef<string | null>(null);
  const conversation = useRef(newConversation());
  /** The chat's id as state too, so a new chat starts its own agent. */
  const [convId, setConvId] = useState(conversation.current);
  const [agentState, setAgentState] = useState<AgentState | null>(null);
  /** Bumped to start the agent again (after Stop). */
  const [warmKey, setWarmKey] = useState(0);
  // Each provider's live model list (GET /assistant/models), asked for once it has a key.
  const [live, setLive] = useState<Record<string, ModelInfo[]>>({});
  const [modelsFailed, setModelsFailed] = useState<Record<string, boolean>>({});
  const [modelsBusy, setModelsBusy] = useState(false);
  const modelsAsked = useRef(new Set<string>());

  const [entries, setEntries] = useState<Entry[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  /** What the chat is waiting for, and since when (the status line ticks). */
  const [working, setWorkingState] = useState<{ text: string; since: number } | null>(null);
  const setWorking = (text: string | null, since = Date.now()) => setWorkingState(text === null ? null : { text, since });
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => setTick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, [working]);
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
      const signedIn = (s.sign_in?.methods ?? []).some(m => m.state === 'signed_in');
      if (s.enabled && !signedIn && !s.providers.some(p => p.available && p.configured)) setSetupOpen(true);
    }).catch(e => setStatusError((e as Error).message));
  }, [shown, asked]);

  // While a sign-in waits for the provider's page, ask the server until it is done.
  const methods = status?.sign_in?.methods ?? [];
  const pending = methods.some(m => m.state === 'pending');
  useEffect(() => {
    if (!pending) return;
    const until = Date.now() + POLL_FOR_MS;
    const timer = setInterval(() => {
      if (Date.now() > until) return clearInterval(timer);
      fetchStatus().then(setStatus).catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending]);

  useEffect(() => {
    logRef.current?.scrollTo?.({ top: logRef.current.scrollHeight });
  }, [entries, working]);

  const providers = status?.providers ?? [];
  const signedIn = methods.filter(m => m.state === 'signed_in');
  // The account in use: the one chosen, else a signed-in one, else a provider with a key.
  const chosenId = providers.some(p => p.id === prefs.provider && p.available) || signedIn.some(m => m.id === prefs.provider)
    ? prefs.provider!
    : signedIn[0]?.id ?? status?.default_provider ?? providers.find(p => p.available && p.configured)?.id ?? providers.find(p => p.available)?.id ?? '';
  const account: SignInMethod | undefined = signedIn.find(m => m.id === chosenId);
  const provider: ProviderInfo | undefined = account ? undefined : providers.find(p => p.id === chosenId);
  const model = account
    ? (prefs.models?.[account.id] ?? account.model)
    : (provider && prefs.models?.[provider.id]) ?? provider?.model ?? '';
  const agent = account?.kind === 'local_agent';
  const ready = account ? Boolean(agent || model) : Boolean(provider?.available && provider.configured && model);

  // Start the signed-in agent as soon as it is chosen and the tab is shown, not at
  // the first question, and follow its start until it is ready.
  useEffect(() => {
    if (!shown || !agent) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const follow = (s: AgentState) => {
      if (!live) return;
      setAgentState(s);
      if (s.phase === 'installing' || s.phase === 'starting') {
        timer = setTimeout(() => { fetchAgentState(convId).then(follow).catch(() => undefined); }, 1000);
      }
    };
    startAgent(convId).then(follow).catch(e => {
      if (live) setAgentState({ phase: 'error', text: (e as Error).message, elapsed: 0, error: (e as Error).message, note: null });
    });
    return () => { live = false; clearTimeout(timer); };
  }, [shown, agent, convId, warmKey]);

  // Finish a sign-in this page started: use that account.
  useEffect(() => {
    const id = starting.current;
    const m = methods.find(x => x.id === id);
    if (!m || m.state === 'pending') return;
    starting.current = null;
    setSignUrl(null);
    if (m.state === 'signed_in') {
      choose(m.id);
      setSignMsg(null);
      setSetupOpen(false);
    } else if (m.detail) {
      setSignMsg({ text: m.detail, error: true });
    }
  }, [status]);  // eslint-disable-line react-hooks/exhaustive-deps
  const canList = Boolean(provider?.available && provider.configured);

  const loadModels = useCallback(async (id: string, refresh = false) => {
    modelsAsked.current.add(id);
    setModelsBusy(true);
    setModelsFailed(f => ({ ...f, [id]: false }));
    try {
      const r = await fetchModels(id, refresh);
      setLive(l => ({ ...l, [id]: r.models }));
    } catch {
      setModelsFailed(f => ({ ...f, [id]: true }));
    } finally {
      setModelsBusy(false);
    }
  }, []);
  useEffect(() => {
    if (setupOpen && provider && canList && !modelsAsked.current.has(provider.id)) void loadModels(provider.id);
  }, [setupOpen, provider, canList, loadModels]);
  // The live list first, then the built-in names it does not have.
  const liveModels = provider ? live[provider.id] ?? [] : [];
  const liveIds = new Set(liveModels.map(m => m.id));
  const modelOptions: ModelInfo[] = [
    ...liveModels,
    ...(provider?.models ?? []).filter(m => !liveIds.has(m)).map(id => ({ id, label: null })),
  ];

  const choose = (id: string) => {
    const next = { ...prefs, provider: id };
    setPrefs(next);
    savePrefs(next);
    setKeyDraft('');
    setKeyMsg(null);
  };
  const setModel = (m: string) => {
    const id = account?.id ?? provider?.id;
    if (!id) return;
    const next = { ...prefs, models: { ...prefs.models, [id]: m } };
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
      modelsAsked.current.delete(provider.id);
      setLive(({ [provider.id]: _gone, ...rest }) => rest);
      setKeyMsg({ text: 'Removed.' });
    } catch (e) {
      setKeyMsg({ text: `Could not remove: ${(e as Error).message}`, error: true });
    }
  };

  const startSignIn = async (m: SignInMethod, consent = false) => {
    setSignMsg(null);
    const openUrl = window.pywebview?.api?.open_url;
    // Open the tab now, while the click still counts, and send it to OpenAI's page below.
    let tab: Window | null = null;
    if (m.kind === 'oauth' && !openUrl) {
      tab = window.open('about:blank', '_blank');
      if (tab) tab.opener = null;
    }
    try {
      const s = await signIn(m.id, consent);
      starting.current = m.id;
      if (s.sign_in_url) {
        setSignUrl(s.sign_in_url);
        if (openUrl) await openUrl(s.sign_in_url);
        else if (tab) tab.location.href = s.sign_in_url;
      }
      setStatus(s);
    } catch (e) {
      tab?.close();
      starting.current = null;
      setSignMsg({ text: `Could not sign in: ${(e as Error).message}`, error: true });
    }
  };
  const endSignIn = async (m: SignInMethod) => {
    if (agent && account?.id === m.id) void stopAgent(conversation.current);
    try {
      const s = await signOut(m.id);
      setStatus(s);
      setSignUrl(null);
      starting.current = null;
      setSignMsg(s.note ? { text: s.note, error: true } : null);
    } catch (e) {
      setSignMsg({ text: `Could not sign out: ${(e as Error).message}`, error: true });
    }
  };
  const welcomed = (id: string) => (prefs.welcomed ?? []).includes(id);
  const dismissWelcome = (id: string) => {
    const next = { ...prefs, welcomed: [...(prefs.welcomed ?? []), id] };
    setPrefs(next);
    savePrefs(next);
  };

  const add = (e: Entry) => setEntries(list => [...list, e]);
  const appendText = (text: string) => setEntries(list => {
    const last = list[list.length - 1];
    if (last?.kind === 'assistant') return [...list.slice(0, -1), { ...last, text: last.text + text }];
    return [...list, { kind: 'assistant', text }];
  });
  const setTool = (id: string, s: 'ok' | 'error') =>
    setEntries(list => list.map(e => (e.kind === 'tool' && e.id === id ? { ...e, state: s, ms: Date.now() - e.started } : e)));
  const setPermission = (id: string, s: PermissionState, onlyOpen = false) =>
    setEntries(list => list.map(e => (e.kind === 'permission' && e.id === id && (!onlyOpen || e.state === 'open') ? { ...e, state: s } : e)));
  const answer = async (id: string, choice: 'allow' | 'allow_always' | 'reject') => {
    setPermission(id, choice);
    try {
      await answerPermission(conversation.current, id, choice);
    } catch (e) {
      setPermission(id, 'closed');
      add({ kind: 'error', text: `The answer did not reach the agent: ${(e as Error).message}` });
    }
  };

  const ask = useCallback(async () => {
    const text = question.trim();
    const using = account?.id ?? provider?.id;
    if (!text || busy || !using || !ready) return;
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
    const thinking = agent && account ? `${serviceName(account)} is thinking…` : 'Thinking…';
    setWorking(thinking);
    const controller = new AbortController();
    abort.current = controller;
    let failed = false;
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        let waiting: { calls: { id: string; name: string; input: Record<string, unknown> }[]; results: ToolResult[] } | null = null;
        let stop = '';
        let detail = '';
        await streamChat(
          {
            provider: using, model: agent ? '' : model, messages: history.current, page_tools: agent ? [] : PAGE_TOOLS, dataset,
            ...(agent ? { conversation: conversation.current } : {}),
          },
          (ev: ChatEvent) => {
            switch (ev.type) {
              case 'text': setWorking(null); appendText(ev.text); break;
              case 'message':
                history.current.push(ev.message);
                if (ev.message.role === 'assistant') setEntries(l => [...l, { kind: 'note', text: '' }]);
                break;
              case 'tool_call':
                setWorking(`${toolStatus(ev.name, ev.status)}…`);
                add({ kind: 'tool', id: ev.id, name: ev.name, input: ev.input, state: 'running', where: ev.runs === 'agent' ? 'agent' : 'server', started: Date.now() });
                break;
              case 'status':
                setWorking(ev.text, Date.now() - (ev.elapsed ?? 0) * 1000);
                if (ev.phase) setAgentState(a => ({ phase: ev.phase!, text: ev.text, elapsed: ev.elapsed ?? 0, error: null, note: a?.note ?? null }));
                break;
              case 'permission':
                setWorking(null);
                add({
                  kind: 'permission', id: ev.id, name: ev.name, title: ev.title, detail: ev.detail,
                  always: ev.options.some(o => o.kind === 'allow_always'), state: 'open',
                });
                break;
              case 'permission_closed':
                setPermission(ev.id, ev.outcome === 'timeout' ? 'timeout' : 'closed', true);
                setWorking(thinking);
                break;
              case 'tool_result':
                setTool(ev.id, ev.ok ? 'ok' : 'error');
                setWorking(thinking);
                if (ev.ok) showResult(ev.name, ev.input, ctx);
                break;
              case 'page_tools': waiting = { calls: ev.calls, results: ev.results }; break;
              case 'error': {
                failed = true;
                const usage = ev.code?.startsWith('subscription_sharing_usage') && account?.usage_url;
                add({
                  kind: 'error', text: `${ERRORS[ev.kind] ?? ''} ${ev.message}`.trim(),
                  ...(usage ? { link: { href: usage, text: 'Manage usage' } } : {}),
                });
                break;
              }
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
        const { calls, results } = waiting as { calls: { id: string; name: string; input: Record<string, unknown> }[]; results: ToolResult[] };
        const done: ToolResult[] = [...results];
        for (const call of calls) {
          setWorking(`${toolStatus(call.name)}…`);
          add({ kind: 'tool', id: call.id, name: call.name, input: call.input, state: 'running', where: 'page', started: Date.now() });
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
        setWorking(thinking);
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
  }, [question, busy, provider, account, agent, ready, model, dispatch, fetchPointTimeSeries, fetchBufferTimeSeries, currentDatasetId]);

  const stop = () => {
    abort.current?.abort();
    // Stop ends the agent's process; a fresh one starts for the next question.
    if (agent) void stopAgent(conversation.current).then(() => setWarmKey(k => k + 1));
  };
  const newChat = () => {
    if (busy) return;
    if (agent) void stopAgent(conversation.current);
    conversation.current = newConversation();
    setConvId(conversation.current);
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
        <SectionHeader label="Sign in or use a key" collapsed={!setupOpen} onToggle={() => setSetupOpen(o => !o)} />
        {!setupOpen && account && (
          <div className="row-label ai-small">
            {serviceName(account)} · {account.account ? `Signed in as ${account.account}` : 'Signed in'}{account.plan ? ` · ${account.plan}` : ''}
          </div>
        )}
        {!setupOpen && !account && provider && (
          <div className="row-label ai-small">
            {provider.label} · {model || 'no model'} · {provider.configured ? (provider.needs_key ? (keyed ? `key ${provider.hint ?? 'saved'}` : 'server key') : 'no key needed') : 'no key yet'}
          </div>
        )}
        {setupOpen && (
          <>
            {status.sign_in?.allowed ? (
              <div className="ai-signins">
                {methods.map(m => (
                  <SignInRow key={m.id} m={m} inUse={account?.id === m.id} url={starting.current === m.id ? signUrl : null}
                    onSignIn={() => void startSignIn(m)} onConsent={() => void startSignIn(m, true)}
                    onSignOut={() => void endSignIn(m)} onUse={() => choose(m.id)} />
                ))}
              </div>
            ) : status.sign_in?.reason ? (
              <>
                <div className="row-label ai-small">{status.sign_in.reason}</div>
                <SubscriptionNote />
              </>
            ) : null}
            {signMsg && <div className={`row-label ai-small${signMsg.error ? ' ai-error' : ''}`} role={signMsg.error ? 'alert' : 'status'}>{signMsg.text}</div>}
            {account && account.kind === 'oauth' && (
              <label className="ai-field">
                <span className="minmax-label">{serviceName(account)} model</span>
                <input aria-label="Model" className="sidebar-input ai-text" list="ai-account-models" value={model}
                  placeholder="Model name" onChange={e => setModel(e.target.value.trim())} />
                <datalist id="ai-account-models">{account.models.map(x => <option key={x} value={x} />)}</datalist>
              </label>
            )}
            <button type="button" className="ai-disclosure" aria-expanded={keysOpen || !status.sign_in?.allowed}
              onClick={() => setKeysOpen(o => !o)} hidden={!status.sign_in?.allowed}>
              <i className={`fa-solid fa-chevron-${keysOpen ? 'down' : 'right'}`} aria-hidden="true"></i> Use an API key
            </button>
          </>
        )}
        {setupOpen && (keysOpen || !status.sign_in?.allowed) && (
          <>
            <label className="ai-field">
              <span className="minmax-label">Provider</span>
              <select aria-label="Provider" className="sidebar-select" value={account ? '' : chosenId} onChange={e => choose(e.target.value)}>
                {account && <option value="" disabled>Choose a provider</option>}
                {providers.map(p => (
                  <option key={p.id} value={p.id} disabled={!p.available}>
                    {p.label}{p.available ? '' : ` (${p.note.replace(/\.$/, '').toLowerCase() || 'later'})`}
                  </option>
                ))}
              </select>
            </label>
            {provider && !account && (
              <div className="ai-field">
                <span className="minmax-label">Model</span>
                <div className="ai-model">
                  <input aria-label="Model" className="sidebar-input ai-text" list="ai-models" value={model}
                    placeholder={provider.local ? 'Model name, e.g. qwen3' : ''} onChange={e => setModel(e.target.value.trim())} />
                  {canList && (
                    <button type="button" className="ov-icon-btn" onClick={() => void loadModels(provider.id, true)} disabled={modelsBusy}
                      title="Refresh the model list" aria-label="Refresh the model list">
                      <i className={`fa-solid fa-rotate${modelsBusy ? ' fa-spin' : ''}`} aria-hidden="true"></i>
                    </button>
                  )}
                </div>
                <datalist id="ai-models">
                  {modelOptions.map(m => <option key={m.id} value={m.id} label={m.label ?? undefined} />)}
                </datalist>
                {modelsFailed[provider.id] && <div className="row-label ai-small" role="status">Couldn't load the model list.</div>}
              </div>
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
                A model installed with Ollama on the computer that runs Bowser: no key, nothing leaves it.
              </div>
            )}
          </>
        )}
      </div>

      {account?.id === 'chatgpt' && !welcomed('chatgpt') && (
        <div className="sidebar-section ai-welcome" role="status">
          <strong className="ai-note">You're using your ChatGPT plan</strong>
          <div className="row-label ai-small">
            Eligible usage in Bowser uses your ChatGPT plan. Manage usage in your{' '}
            {account.usage_url ? <a href={account.usage_url} target="_blank" rel="noopener noreferrer">ChatGPT settings</a> : 'ChatGPT settings'}.
          </div>
          <button type="button" className="hist-btn ai-inline-btn" onClick={() => dismissWelcome('chatgpt')}>Got it</button>
        </div>
      )}

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
            if (e.kind === 'permission') {
              return <PermissionCard key={i} e={e} agentName={account ? serviceName(account) : 'The agent'} onAnswer={c => void answer(e.id, c)} />;
            }
            if (e.kind === 'tool') {
              return (
                <div key={i} className={`ai-tool ${e.state}`} title={e.where === 'page' ? 'On the page' : e.where === 'agent' ? 'Run by the agent' : 'Read on the server'}>
                  <i className={`fa-solid ${e.state === 'running' ? 'fa-circle-notch fa-spin' : e.state === 'ok' ? (e.where === 'page' ? 'fa-map-location-dot' : 'fa-check') : 'fa-triangle-exclamation'}`} aria-hidden="true"></i>
                  <span>{callText(e.name, e.input)}</span>
                  {e.ms !== undefined && <span className="ai-tool-time" title="How long it took">{seconds(e.ms)}</span>}
                </div>
              );
            }
            if (e.kind === 'note' && !e.text) return null;
            if (e.kind === 'error') {
              return (
                <div key={i} className="ai-msg ai-error" role="alert">
                  {e.text}{e.link && <> <a href={e.link.href} target="_blank" rel="noopener noreferrer">{e.link.text}</a></>}
                </div>
              );
            }
            return <div key={i} className={`ai-msg ai-${e.kind}`}><Markdown text={e.text} /></div>;
          })}
          {working && (
            <div className="ai-working row-label" role="status" aria-label="Working">
              <span className="ai-spinner" aria-hidden="true" />{working.text} {Math.floor(Math.max(0, Date.now() - working.since) / 1000)} s
            </div>
          )}
        </div>
        <textarea aria-label="Question" className="sidebar-input ai-text ai-input" rows={3} value={question}
          placeholder={ready ? 'Ask about the data on the map…' : 'Sign in or add a key above'}
          disabled={!ready && !busy} onChange={e => setQuestion(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(); } }} />
        <div className="ai-row">
          <button type="button" className="hist-btn" onClick={newChat} disabled={busy || entries.length === 0}>New chat</button>
          {busy
            ? <button type="button" className="hist-btn ai-primary" onClick={stop}>Stop</button>
            : <button type="button" className="hist-btn ai-primary" onClick={() => void ask()} disabled={!ready || !question.trim()}>Send</button>}
        </div>
        {account?.id === 'chatgpt' && account.usage_url && (
          <div className="row-label ai-small">
            Using ChatGPT plan · <a href={account.usage_url} target="_blank" rel="noopener noreferrer">Manage usage</a>
          </div>
        )}
        {agent && account && <AgentStatus state={agentState} plan={account.plan} />}
        <div className="row-label ai-small">
          Answers come from satellite data and can be wrong: line-of-sight motion relative to a reference point and date.
          Confirm any finding with a qualified expert before acting on it.
        </div>
      </div>
    </>
  );
}

/** Where signing in is not possible: Claude Code and Claude Desktop can still reach Bowser through MCP. */
function SubscriptionNote() {
  return (
    <div className="row-label ai-small">
      On your own computer you can sign in with Claude or ChatGPT here. Claude Code or Claude Desktop can also work with
      Bowser through <code>bowser mcp</code>: <a href={MCP_DOCS} target="_blank" rel="noopener noreferrer">how to connect</a>.
    </div>
  );
}

/** One sign-in method: its button, or who is signed in with Sign out, or why it cannot be used. */
function SignInRow({ m, inUse, url, onSignIn, onConsent, onSignOut, onUse }: {
  m: SignInMethod; inUse: boolean; url: string | null;
  onSignIn: () => void; onConsent: () => void; onSignOut: () => void; onUse: () => void;
}) {
  const name = serviceName(m);
  if (m.state === 'signed_in') {
    return (
      <div className="ai-signin" aria-label={name}>
        <div className="row-label ai-small">
          <strong>{name}</strong> · {m.account ? `Signed in as ${m.account}` : 'Signed in'}{m.plan ? ` · ${m.plan}` : ''}
        </div>
        <div className="ai-row">
          {inUse
            ? <span className="row-label ai-small ai-in-use"><i className="fa-solid fa-check" aria-hidden="true"></i> In use</span>
            : <button type="button" className="hist-btn ai-inline-btn" onClick={onUse}>Use {name}</button>}
          <button type="button" className="hist-btn ai-inline-btn" onClick={onSignOut}>Sign out</button>
        </div>
      </div>
    );
  }
  if (m.state === 'pending') {
    return (
      <div className="ai-signin" aria-label={name}>
        <div className="ai-working row-label" role="status">
          <span className="ai-spinner" aria-hidden="true" />
          Finish signing in on {m.vendor}'s page in your browser…
        </div>
        <div className="ai-row">
          {url && <a className="row-label ai-small" href={url} target="_blank" rel="noopener noreferrer">Open the page again</a>}
          <button type="button" className="hist-btn ai-inline-btn" onClick={onSignOut}>Cancel</button>
        </div>
      </div>
    );
  }
  if (m.state === 'not_installed') {
    return (
      <div className="ai-signin" aria-label={name}>
        <button type="button" className="hist-btn ai-signin-btn" disabled>{m.label}</button>
        <div className="row-label ai-small">
          {m.kind === 'local_agent' ? 'Claude Code is needed: ' : ''}
          {m.install_url ? <>install it from <a href={m.install_url} target="_blank" rel="noopener noreferrer">claude.com</a>.</> : 'it is not installed.'}
          {m.detail ? ` ${m.detail}` : ''}
        </div>
      </div>
    );
  }
  return (
    <div className="ai-signin" aria-label={name}>
      <button type="button" className="hist-btn ai-signin-btn" onClick={m.state === 'no_plan' ? onConsent : onSignIn}>{m.label}</button>
      <div className={`row-label ai-small${m.detail ? ' ai-error' : ''}`}>{m.detail ?? m.blurb}</div>
    </div>
  );
}

/** How far the signed-in agent has started: installing (first time only), starting, ready; with the seconds. */
function AgentStatus({ state, plan }: { state: AgentState | null; plan: string | null }) {
  if (!state?.phase || state.phase === 'none') return null;
  const seconds = `${Math.round(state.elapsed)} s`;
  return (
    <>
      {state.phase === 'installing' || state.phase === 'starting' ? (
        <div className="ai-working row-label" role="status" aria-label="Agent status">
          <span className="ai-spinner" aria-hidden="true" />{state.text} {seconds}
        </div>
      ) : state.phase === 'ready' ? (
        <div className="row-label ai-small" role="status" aria-label="Agent status">
          Ready ({seconds}) · Claude Code on this computer, with your {plan ?? 'Claude'} plan.
        </div>
      ) : (
        <div className="row-label ai-small ai-error" role="alert">{state.error ?? state.text}</div>
      )}
      {state.note && <div className="row-label ai-small">{state.note}</div>}
    </>
  );
}

/** An agent's request to run a tool: Allow, Always allow (when offered) or Deny. Unanswered, it is declined. */
function PermissionCard({ e, agentName, onAnswer }: {
  e: Extract<Entry, { kind: 'permission' }>; agentName: string; onAnswer: (c: 'allow' | 'allow_always' | 'reject') => void;
}) {
  const after: Record<Exclude<PermissionState, 'open'>, string> = {
    allow: 'Allowed.', allow_always: 'Allowed for this chat.', reject: 'Denied.',
    timeout: 'Not answered in time, so it was denied.', closed: 'No longer asked.',
  };
  return (
    <div className="ai-permission" role="group" aria-label={`Allow ${e.name}?`}>
      <div className="row-label ai-small"><strong>{agentName} wants to run {e.name}</strong></div>
      {e.detail && e.detail !== '{}' && <code className="ai-permission-detail">{e.detail}</code>}
      {e.state === 'open' ? (
        <div className="ai-row">
          <button type="button" className="hist-btn ai-primary ai-inline-btn" onClick={() => onAnswer('allow')}>Allow</button>
          {e.always && <button type="button" className="hist-btn ai-inline-btn" onClick={() => onAnswer('allow_always')}>Always allow</button>}
          <button type="button" className="hist-btn ai-inline-btn" onClick={() => onAnswer('reject')}>Deny</button>
        </div>
      ) : (
        <div className="row-label ai-small">{after[e.state]}</div>
      )}
    </div>
  );
}
