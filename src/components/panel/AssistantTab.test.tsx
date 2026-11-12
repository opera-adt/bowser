/** The Assistant tab: providers and keys, a streamed conversation whose tools act on the page, errors, and the off state. */
import { useEffect } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../../context/AppContext';
import type { AppAction, AppState, RasterGroup } from '../../types';
import AssistantTab from './AssistantTab';

const LABELS = ['2020-01-01', '2020-07-01', '2021-01-01'];
const layer = {
  name: 'displacement', unit: 'meters', file_list: [], mask_file_list: [], mask_min_value: 0, nodata: null,
  uses_spatial_ref: true, algorithm: 'shift', x_values: LABELS,
  latlon_bounds: [-90.2, 34.7, -90.0, 34.8], available_mask_vars: [],
} as unknown as RasterGroup;

const provider = (over: Record<string, unknown>) => ({
  wire: 'openai', model: '', models: [], needs_key: true, local: false, auth: 'api_key',
  available: true, note: '', key_url: '', configured: false, source: null, hint: null, store: null, ...over,
});
const ANTHROPIC = provider({ id: 'anthropic', label: 'Anthropic', wire: 'anthropic', model: 'claude-opus-5-5', models: ['claude-opus-5-5', 'claude-sonnet-5-5'], key_url: 'https://console.anthropic.com/settings/keys' });
const OLLAMA = provider({ id: 'ollama', label: 'Ollama (local)', model: 'qwen3', models: ['qwen3'], needs_key: false, local: true, auth: 'none', configured: true });
const method = (over: Record<string, unknown> & { id: string }) => ({
  state: 'signed_out', account: null, plan: null, detail: null, install_url: null, usage_url: null, model: '', models: [], ...over,
});
const CLAUDE_IN = method({
  id: 'claude', label: 'Sign in with Claude', kind: 'local_agent', vendor: 'Anthropic',
  blurb: 'Uses Claude Code on this computer and your Claude plan.', install_url: 'https://code.claude.com/docs/en/setup',
});
const CHATGPT_IN = method({
  id: 'chatgpt', label: 'Continue with ChatGPT', kind: 'oauth', vendor: 'OpenAI', blurb: 'Uses your ChatGPT plan.',
  usage_url: 'https://chatgpt.com/settings/usage?tab=overview',
});
const SIGN_IN = { allowed: true, reason: null, methods: [CLAUDE_IN, CHATGPT_IN] };
/** Choose a service in the one "Sign in with" drop-down. */
const pickService = (id: string) => fireEvent.change(screen.getByRole('combobox', { name: 'Sign in with' }), { target: { value: id } });

const STATUS = { enabled: true, page_keys: true, default_provider: null, providers: [ANTHROPIC, OLLAMA], sign_in: SIGN_IN };

const sse = (...events: object[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), {
  headers: { 'content-type': 'text/event-stream' },
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { url: string; method: string; body: any };  // eslint-disable-line @typescript-eslint/no-explicit-any
/** A fetch that answers by route; records every call. `chats` are the /assistant/chat answers in turn. */
function server(status: unknown, chats: Response[] = [], extra: (c: Call) => Response | null = () => null) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const call = { url: String(input), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const other = extra(call);
    if (other) return other;
    if (call.url.startsWith('/assistant/status')) return json(status);
    if (call.url.startsWith('/assistant/chat')) return chats.shift() ?? json({ detail: 'no more' }, 500);
    if (call.url.startsWith('/assistant/models')) return json({ detail: 'no list' }, 502);
    if (call.url.startsWith('/point')) return json([0, 0.001, 0.002]);
    return json({});
  }));
  return calls;
}

let stateRef: AppState;
function Seed({ setup = [] }: { setup?: AppAction[] }) {
  const { state, dispatch } = useAppContext();
  stateRef = state;
  useEffect(() => {
    dispatch({ type: 'SET_DATASETS', payload: { displacement: layer } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: 'displacement' });
    dispatch({ type: 'SET_PANEL_TAB', payload: 'assistant' });
    setup.forEach(dispatch);
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return state.datasetInfo.displacement ? <AssistantTab /> : null;
}
const renderTab = () => render(<AppProvider><Seed /></AppProvider>);
/** Open the setup section and the API key form behind "Use an API key". */
async function openKeys() {
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in or use a key' }));
  fireEvent.click(screen.getByRole('button', { name: /Use an API key/ }));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AssistantTab', () => {
  it('renders the chat with a ready provider', async () => {
    server(STATUS);
    renderTab();
    expect(await screen.findByText(/Ollama \(local\) · qwen3 · no key needed/)).toBeTruthy();
    const box = screen.getByRole('textbox', { name: 'Question' }) as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    expect(screen.getByText(/qualified expert/)).toBeTruthy();
  });

  it('chooses a provider, saves a key on the server and removes it', async () => {
    const saved = { ...STATUS, stored_in: 'the system keychain', providers: [{ ...ANTHROPIC, configured: true, source: 'saved', hint: '…abcd', store: 'keyring' }, OLLAMA] };
    const calls = server(STATUS, [], c => {
      if (c.url === '/assistant/key' && c.method === 'PUT') return json(saved);
      if (c.url.startsWith('/assistant/key') && c.method === 'DELETE') return json(STATUS);
      return null;
    });
    renderTab();
    await openKeys();
    const select = screen.getByRole('combobox', { name: 'Provider' }) as HTMLSelectElement;
    // Signing in is not a provider with a key.
    expect(within(select).queryByRole('option', { name: /ChatGPT/ })).toBeNull();
    // A local provider takes no key and no base URL: nothing to set up.
    expect(screen.queryByLabelText('API key')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Base URL' })).toBeNull();
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    expect(screen.getByText(/installed with Ollama on the computer that runs Bowser/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Get Ollama/ })).toBeNull();

    fireEvent.change(select, { target: { value: 'anthropic' } });
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLInputElement).value).toBe('claude-opus-5-5');
    // No key yet: the provider's own list is not asked for.
    expect(calls.some(c => c.url.startsWith('/assistant/models?provider=anthropic'))).toBe(false);
    const key = screen.getByLabelText('API key') as HTMLInputElement;
    expect(key.type).toBe('password');
    expect((screen.getByRole('textbox', { name: 'Question' }) as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.change(key, { target: { value: 'sk-ant-test-abcd' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check and save' }));

    expect(await screen.findByText('Saved on this computer (…abcd)')).toBeTruthy();
    expect(calls.find(c => c.method === 'PUT')!.body).toEqual({ provider: 'anthropic', key: 'sk-ant-test-abcd' });
    expect(screen.queryByLabelText('API key')).toBeNull();
    // The key is not kept in the page.
    expect(JSON.stringify(localStorage)).not.toContain('sk-ant');
    expect(document.body.innerHTML).not.toContain('sk-ant-test');

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByLabelText('API key')).toBeTruthy();
    expect(calls.some(c => c.method === 'DELETE' && c.url === '/assistant/key?provider=anthropic')).toBe(true);
  });

  it("shows the provider's live model list once a key is saved, merged with the built-in one, and refreshes it", async () => {
    const keyed = { ...STATUS, default_provider: 'anthropic', providers: [{ ...ANTHROPIC, configured: true, source: 'saved', hint: '…abcd' }, OLLAMA] };
    const lists = [
      [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }, { id: 'claude-next-6', label: 'Claude Next 6' }],
      [{ id: 'claude-next-6', label: 'Claude Next 6' }, { id: 'claude-newer-7', label: null }],
    ];
    const calls = server(keyed, [], c => (c.url.startsWith('/assistant/models')
      ? json({ provider: 'anthropic', models: lists.shift(), cached: false }) : null));
    renderTab();
    await openKeys();
    const options = () => Array.from(document.querySelectorAll('#ai-models option')).map(o => [(o as HTMLOptionElement).value, o.getAttribute('label')]);
    await waitFor(() => expect(options()).toEqual([
      ['claude-opus-5-5', 'Claude Opus 5.5'], ['claude-next-6', 'Claude Next 6'], ['claude-sonnet-5-5', null],
    ]));
    expect(calls.filter(c => c.url.startsWith('/assistant/models'))).toEqual([
      { url: '/assistant/models?provider=anthropic', method: 'GET', body: null },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh the model list' }));
    await waitFor(() => expect(options().map(o => o[0])).toEqual(['claude-next-6', 'claude-newer-7', 'claude-opus-5-5', 'claude-sonnet-5-5']));
    expect(calls[calls.length - 1].url).toBe('/assistant/models?provider=anthropic&refresh=true');

    // Any model id can still be typed.
    const input = screen.getByRole('combobox', { name: 'Model' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'claude-private-preview' } });
    expect(input.value).toBe('claude-private-preview');
    expect(screen.queryByText("Couldn't load the model list.")).toBeNull();
  });

  it('asks a local provider for its models at once, and says quietly when the list cannot be loaded', async () => {
    const calls = server(STATUS);
    renderTab();
    await openKeys();
    const note = await screen.findByText("Couldn't load the model list.");
    expect(note.getAttribute('role')).toBe('status');
    expect(calls.filter(c => c.url.startsWith('/assistant/models')).map(c => c.url)).toEqual(['/assistant/models?provider=ollama']);
    // The built-in names are still offered, and the chat still works.
    expect(Array.from(document.querySelectorAll('#ai-models option')).map(o => (o as HTMLOptionElement).value)).toEqual(['qwen3']);
    expect((screen.getByRole('textbox', { name: 'Question' }) as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('streams an answer whose tools put points on the map and chart', async () => {
    const assistantTurn = {
      role: 'assistant', content: 'Reading the series.',
      tool_calls: [
        { id: 'c1', name: 'point_timeseries', input: { lon: -90.1, lat: 34.75 } },
        { id: 'c2', name: 'add_point', input: { lon: -90.05, lat: 34.72, name: 'Dam crest' } },
      ],
    };
    const calls = server(STATUS, [
      sse(
        { type: 'text', text: 'Reading the series.' },
        { type: 'message', message: assistantTurn },
        { type: 'tool_call', id: 'c1', name: 'point_timeseries', input: { lon: -90.1, lat: 34.75 }, runs: 'server' },
        { type: 'tool_result', id: 'c1', name: 'point_timeseries', input: { lon: -90.1, lat: 34.75 }, ok: true, result: { values: [0, 1] } },
        { type: 'page_tools', calls: [assistantTurn.tool_calls[1]], results: [{ id: 'c1', name: 'point_timeseries', content: '{"values":[0,1]}', is_error: false }] },
        { type: 'done', stop: 'page_tools' },
      ),
      sse(
        { type: 'text', text: 'The crest is ' },
        { type: 'text', text: 'stable.' },
        { type: 'message', message: { role: 'assistant', content: 'The crest is stable.' } },
        { type: 'done', stop: 'end' },
      ),
    ]);
    renderTab();
    const box = await screen.findByRole('textbox', { name: 'Question' });
    fireEvent.change(box, { target: { value: 'Is the dam crest moving?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('The crest is stable.')).toBeTruthy();
    // The data tool's point and the page tool's point are on the map, and the chart is open.
    await waitFor(() => expect(stateRef.timeSeriesPoints.map(p => p.name)).toEqual(['AI 1', 'Dam crest']));
    expect(stateRef.timeSeriesPoints[1].position).toEqual([34.72, -90.05]);
    expect(stateRef.showChart).toBe(true);
    expect(screen.getByText(/add_point\(lon -90.05, lat 34.72/)).toBeTruthy();

    const chats = calls.filter(c => c.url === '/assistant/chat');
    expect(chats).toHaveLength(2);
    const first = chats[0].body;
    expect(first.provider).toBe('ollama');
    expect(first.model).toBe('qwen3');
    // What the page shows goes with the question, apart from it (the server tells the model).
    expect(first.messages[0].content).toBe('Is the dam crest moving?');
    expect(first.page_context).toMatchObject({ layer: 'displacement', date_shown: '2020-01-01', time_index: 0, points: [], masks: [] });
    // The page tools are the server's (src/bowser/tools.py); the page sends its masks.
    expect(first.page_tools).toEqual([]);
    expect(first.page_masks).toEqual([]);
    // The second request sends both results back, in the order of the calls.
    const toolMsg = chats[1].body.messages.at(-1);
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.results.map((r: { id: string }) => r.id)).toEqual(['c1', 'c2']);
    expect(JSON.parse(toolMsg.results[1].content)).toMatchObject({ ok: true, name: 'Dam crest' });
    expect(chats[1].body.messages.at(-2)).toEqual(assistantTurn);
  });

  it('runs the reference date and layer page actions', async () => {
    server(STATUS, [
      sse(
        { type: 'message', message: { role: 'assistant', content: '', tool_calls: [{ id: 'r', name: 'set_reference_date', input: { date: '2020-06-20' } }] } },
        { type: 'page_tools', calls: [{ id: 'r', name: 'set_reference_date', input: { date: '2020-06-20' } }], results: [] },
        { type: 'done', stop: 'page_tools' },
      ),
      sse({ type: 'text', text: 'Done.' }, { type: 'done', stop: 'end' }),
    ]);
    renderTab();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Question' }), { target: { value: 'Use July 2020 as the reference date' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Done.')).toBeTruthy();
    expect(stateRef.refTimeIndex).toEqual({ displacement: 1 });
  });

  it('shows provider errors and starts the next question clean', async () => {
    const calls = server(STATUS, [
      sse({ type: 'error', kind: 'auth', message: 'OpenAI: Incorrect API key provided.' }),
      sse({ type: 'text', text: 'Hello.' }, { type: 'message', message: { role: 'assistant', content: 'Hello.' } }, { type: 'done', stop: 'end' }),
    ]);
    renderTab();
    const box = await screen.findByRole('textbox', { name: 'Question' });
    fireEvent.change(box, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/did not accept the API key/);
    expect(alert.textContent).toMatch(/Incorrect API key/);
    fireEvent.change(box, { target: { value: 'hello again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Hello.')).toBeTruthy();
    const second = calls.filter(c => c.url === '/assistant/chat')[1].body;
    expect(second.messages).toHaveLength(1);
  });

  it('says when the Assistant is off and how to use a Claude plan instead', async () => {
    server({ enabled: false, page_keys: false, providers: [], default_provider: null });
    renderTab();
    expect(await screen.findByText('The Assistant is off on this server.')).toBeTruthy();
    expect(screen.getByText(/BOWSER_ASSISTANT=1/)).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Question' })).toBeNull();
    expect(screen.getByRole('link', { name: 'how to connect' }).getAttribute('href')).toContain('docs/mcp.md');
  });

  it('asks the server only once the tab is shown', async () => {
    const calls = server(STATUS);
    render(<AppProvider><Hidden /></AppProvider>);
    await new Promise(r => setTimeout(r, 20));
    expect(calls.filter(c => c.url.startsWith('/assistant'))).toHaveLength(0);
  });
});

describe('AssistantTab sign-in', () => {
  const signedIn = (id: string, over: Record<string, unknown> = {}) => ({
    ...STATUS,
    sign_in: { ...SIGN_IN, methods: SIGN_IN.methods.map(m => (m.id === id ? { ...m, state: 'signed_in', ...over } : m)) },
  });
  const CHATGPT_ON = signedIn('chatgpt', { account: 'me@example.com', plan: 'ChatGPT plan', models: ['gpt-6.1-sol'], model: 'gpt-6.1-sol' });
  const CLAUDE_ON = signedIn('claude', { account: 'me@example.com', plan: 'Max' });
  const agentState = (phase: string, text: string, elapsed: number, note: string | null = null) => ({ phase, text, elapsed, error: null, note });
  const READY = agentState('ready', 'Ready', 4.2);

  it('starts Claude Code before the first question and shows each phase with its seconds', async () => {
    const states = [
      agentState('starting', 'Starting Claude Code…', 5),
      agentState('ready', 'Ready', 7.4),
    ];
    const calls = server(CLAUDE_ON, [], c => {
      if (c.url === '/assistant/agent' && c.method === 'POST') return json(agentState('installing', "Installing Anthropic's adapter (first time only)…", 3));
      if (c.url.startsWith('/assistant/agent?')) return json(states.shift() ?? READY);
      if (c.url === '/assistant/stop') return json({ stopped: 1 });
      return null;
    });
    renderTab();
    // Started at once (no question asked), and followed until ready.
    expect(await screen.findByText("Installing Anthropic's adapter (first time only)… 3 s")).toBeTruthy();
    const start = calls.find(c => c.url === '/assistant/agent' && c.method === 'POST')!;
    expect(start.body.conversation).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await screen.findByText('Starting Claude Code… 5 s', {}, { timeout: 3000 })).toBeTruthy();
    expect(await screen.findByText(/^Ready \(7 s\)/, {}, { timeout: 3000 })).toBeTruthy();
    expect(calls.filter(c => c.url === '/assistant/chat')).toHaveLength(0);
  });

  it('a new chat starts its own agent, and npx standing in says so', async () => {
    const calls = server(CLAUDE_ON, [], c => {
      if (c.url === '/assistant/agent' && c.method === 'POST') return json(agentState('ready', 'Ready', 9, 'npm could not install the adapter. Using npx instead, which is slower to start.'));
      if (c.url === '/assistant/stop') return json({ stopped: 1 });
      return null;
    });
    renderTab();
    expect(await screen.findByText(/Using npx instead/)).toBeTruthy();
    const first = calls.find(c => c.url === '/assistant/agent')!.body.conversation;
    // New chat needs an entry first; simulate one with a question that errors.
    fireEvent.change(screen.getByRole('textbox', { name: 'Question' }), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getAllByRole('button', { name: 'New chat' })[1]);
    await waitFor(() => expect(calls.filter(c => c.url === '/assistant/agent')).toHaveLength(2));
    const starts = calls.filter(c => c.url === '/assistant/agent').map(c => c.body.conversation);
    expect(starts[1]).not.toBe(first);
    expect(calls.find(c => c.url === '/assistant/stop')!.body).toEqual({ conversation: first });
  });

  it('auto-allow: an icon in the chat header, remembered in this browser and sent with the chat', async () => {
    localStorage.removeItem('bowser-assistant');
    const calls = server(CLAUDE_ON, [
      sse({ type: 'text', text: 'Done.' }, { type: 'message', message: { role: 'assistant', content: 'Done.' } }, { type: 'done', stop: 'end' }),
    ]);
    renderTab();
    const toggle = await screen.findByRole('button', { name: "Allow Bowser's tools without asking" });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.querySelector('.fa-lock')).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.querySelector('.fa-unlock')).toBeTruthy();
    expect(screen.getByText(/Auto-allow on/)).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('bowser-assistant')!).autoAllow).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Question' }), { target: { value: 'Go to the dam' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Done.')).toBeTruthy();
    const body = calls.find(c => c.url === '/assistant/chat')!.body;
    expect(body.auto_allow).toBe(true);
    expect(body.page_context.layer).toBe('displacement');
    // A new tab in this browser starts with it on.
    cleanup();
    server(CLAUDE_ON);
    renderTab();
    expect((await screen.findByRole('button', { name: "Allow Bowser's tools without asking" })).getAttribute('aria-pressed')).toBe('true');
    localStorage.removeItem('bowser-assistant');
  });

  it('says when the tool calls of a question ran out', async () => {
    server(CLAUDE_ON, [
      sse(
        { type: 'budget', limit: 8 },
        { type: 'text', text: 'Click the dam on the map, please.' },
        { type: 'message', message: { role: 'assistant', content: 'Click the dam on the map, please.' } },
        { type: 'done', stop: 'end' },
      ),
    ]);
    renderTab();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Question' }), { target: { value: 'Where is the dam?' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Stopped after 8 tool calls.')).toBeTruthy();
  });

  it('offers one Sign in with a drop-down of the services, with the API key form below it', async () => {
    const off = { ...STATUS, providers: [ANTHROPIC] };  // nothing ready: the setup opens by itself
    server(off);
    renderTab();
    // One button; its name keeps the service's own words.
    const claude = await screen.findByRole('button', { name: 'Sign in with Claude' });
    expect(claude.textContent?.trim()).toBe('Sign in');
    expect(screen.getByText('Uses Claude Code on this computer and your Claude plan.')).toBeTruthy();
    // The services come in the server's order in the drop-down, before "Use an API key".
    const picker = screen.getByRole('combobox', { name: 'Sign in with' }) as HTMLSelectElement;
    expect(Array.from(picker.options).map(o => o.textContent)).toEqual(['Claude', 'ChatGPT']);
    const buttons = screen.getAllByRole('button').map(b => b.textContent?.trim());
    expect(buttons.filter(t => t === 'Sign in')).toHaveLength(1);
    expect(buttons.indexOf('Sign in')).toBeLessThan(buttons.findIndex(t => t?.includes('Use an API key')));
    pickService('chatgpt');
    expect(screen.getByRole('button', { name: 'Continue with ChatGPT' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in with Claude' })).toBeNull();
    expect(screen.getByText('Uses your ChatGPT plan.')).toBeTruthy();
    expect(screen.queryByLabelText('API key')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Use an API key/ }));
    expect(screen.getByLabelText('API key')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Question' }) as HTMLTextAreaElement).placeholder).toBe('Sign in or add a key above');
  });

  it('continues with ChatGPT in a new tab, waits, then shows who is signed in and signs out', async () => {
    const pending = { ...STATUS, sign_in: { ...SIGN_IN, methods: [CLAUDE_IN, { ...CHATGPT_IN, state: 'pending' }] }, sign_in_url: 'https://auth.openai.com/api/accounts/authorize?x=1' };
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    vi.stubGlobal('open', vi.fn(() => tab));
    let phase: 'out' | 'pending' | 'done' = 'out';
    const calls = server(STATUS, [], c => {
      if (c.url === '/assistant/signin' && c.method === 'POST') { phase = 'pending'; return json(pending); }
      if (c.url.startsWith('/assistant/status')) return json(phase === 'done' ? CHATGPT_ON : phase === 'pending' ? pending : STATUS);
      if (c.url.startsWith('/assistant/signin?method=chatgpt') && c.method === 'DELETE') return json({ ...STATUS, note: null });
      return null;
    });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in or use a key' }));
    pickService('chatgpt');
    fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
    expect(await screen.findByText(/Finish signing in on OpenAI's page/)).toBeTruthy();
    expect(calls.find(c => c.url === '/assistant/signin')!.body).toEqual({ method: 'chatgpt' });
    // The tab opened on the click goes to OpenAI's page, and cannot reach this one.
    expect(tab.location.href).toBe(pending.sign_in_url);
    expect(tab.opener).toBeNull();
    expect(screen.getByRole('link', { name: 'Open the page again' }).getAttribute('href')).toBe(pending.sign_in_url);
    phase = 'done';
    // The tab asks the server until the sign-in is done, then uses the account.
    expect(await screen.findByText(/ChatGPT · Signed in as me@example.com · ChatGPT plan/, {}, { timeout: 4000 })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Question' }) as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.getByText(/Using ChatGPT plan/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Manage usage' }).getAttribute('href')).toContain('chatgpt.com/settings/usage');
    // The welcome note shows once.
    expect(screen.getByText("You're using your ChatGPT plan")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByText("You're using your ChatGPT plan")).toBeNull();
    // No token anywhere in the page.
    expect(JSON.stringify(localStorage)).not.toMatch(/access|refresh/);

    fireEvent.click(screen.getByRole('button', { name: 'Sign in or use a key' }));
    const row = screen.getByLabelText('ChatGPT');
    expect(within(row).getByText(/Signed in as me@example.com · ChatGPT plan/)).toBeTruthy();
    expect(within(row).getByText(/In use/)).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('button', { name: 'Continue with ChatGPT' })).toBeTruthy();
    expect(calls.some(c => c.method === 'DELETE' && c.url === '/assistant/signin?method=chatgpt')).toBe(true);
  }, 10000);

  it('says how to get Claude Code when it is not installed', async () => {
    const missing = { ...STATUS, providers: [ANTHROPIC], sign_in: { ...SIGN_IN, methods: [{ ...CLAUDE_IN, state: 'not_installed' }, CHATGPT_IN] } };
    server(missing);
    renderTab();
    const button = await screen.findByRole('button', { name: 'Sign in with Claude' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Claude Code is needed: install it from/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'claude.com' }).getAttribute('href')).toBe('https://code.claude.com/docs/en/setup');
  });

  it("shows the agent's permission request, sends the answer, and stops the agent on Stop and New chat", async () => {
    const calls = server(CLAUDE_ON, [
      sse(
        { type: 'status', text: "Starting Anthropic's agent…" },
        { type: 'tool_call', id: 't1', name: 'point_timeseries', input: { lon: -90.1, lat: 34.75 }, runs: 'agent' },
        { type: 'permission', id: 'p1', name: 'point_timeseries', title: 'mcp__bowser__point_timeseries', detail: '{"lon": -90.1, "lat": 34.75}', options: [{ kind: 'allow_once', name: 'Allow' }, { kind: 'allow_always', name: 'Always' }, { kind: 'reject_once', name: 'Reject' }], timeout: 120 },
        { type: 'tool_result', id: 't1', name: 'point_timeseries', input: { lon: -90.1, lat: 34.75 }, ok: true, result: null },
        { type: 'text', text: 'It is stable.' },
        { type: 'message', message: { role: 'assistant', content: 'It is stable.' } },
        { type: 'done', stop: 'end' },
      ),
    ], c => (c.url === '/assistant/permission' ? json({ ok: true }) : c.url === '/assistant/stop' ? json({ stopped: 1 })
      : c.url.startsWith('/assistant/agent') ? json(READY) : null));
    renderTab();
    expect(await screen.findByText(/Claude · Signed in as me@example.com · Max/)).toBeTruthy();
    expect(await screen.findByText(/Ready \(4 s\) · Claude Code on this computer, with your Max plan/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Question' }), { target: { value: 'Is it moving?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const card = await screen.findByRole('group', { name: 'Allow point_timeseries?' });
    expect(within(card).getByText('Claude wants to run point_timeseries')).toBeTruthy();
    expect(within(card).getByText('{"lon": -90.1, "lat": 34.75}')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Allow' }));
    expect(await within(card).findByText('Allowed.')).toBeTruthy();
    const chat = calls.find(c => c.url === '/assistant/chat')!.body;
    expect(chat.provider).toBe('claude');
    expect(chat.page_tools).toEqual([]);
    expect(chat.conversation).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(calls.find(c => c.url === '/assistant/permission')!.body).toEqual({ conversation: chat.conversation, id: 'p1', choice: 'allow' });
    // The agent's tool put its point on the map.
    await waitFor(() => expect(stateRef.timeSeriesPoints).toHaveLength(1));
    expect(await screen.findByText('It is stable.')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'New chat' })[1]);
    await waitFor(() => expect(calls.some(c => c.url === '/assistant/stop')).toBe(true));
    expect(calls.find(c => c.url === '/assistant/stop')!.body).toEqual({ conversation: chat.conversation });
  });

  it('a declined or unanswered request says so', async () => {
    server(CLAUDE_ON, [
      sse(
        { type: 'permission', id: 'p1', name: 'list_layers', title: 'list_layers', detail: '{}', options: [{ kind: 'allow_once', name: 'Allow' }, { kind: 'reject_once', name: 'Reject' }], timeout: 120 },
        { type: 'permission_closed', id: 'p1', outcome: 'timeout' },
        { type: 'text', text: 'Not allowed.' },
        { type: 'done', stop: 'end' },
      ),
    ]);
    renderTab();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Question' }), { target: { value: 'layers?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const card = await screen.findByRole('group', { name: 'Allow list_layers?' });
    expect(await within(card).findByText(/Not answered in time, so list_layers was denied\./)).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Always allow' })).toBeNull();
  });

  it('an open request is outlined, counts down, badges the rail; Retry asks again after a timeout', async () => {
    const { useWaiting } = await import('../../assistant/attention');
    let waiting = -1;
    const Probe = () => { waiting = useWaiting(); return null; };
    let release: () => void = () => {};
    const held = new Promise<void>(r => { release = r; });
    const calls = server(CLAUDE_ON, [], c => {
      if (c.url !== '/assistant/chat') return null;
      const n = calls.filter(x => x.url === '/assistant/chat').length;
      if (n === 1) {
        // The first answer stays open (the request waits) until the test lets it time out.
        const body = new ReadableStream({
          async start(ctl) {
            const enc = new TextEncoder();
            ctl.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'permission', id: 'p1', name: 'add_point', title: 'mcp__bowser__add_point', detail: '{}', options: [{ kind: 'allow_once', name: 'Allow' }, { kind: 'reject_once', name: 'Reject' }], timeout: 600 })}\n\n`));
            await held;
            ctl.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'permission_closed', id: 'p1', outcome: 'timeout' })}\n\ndata: ${JSON.stringify({ type: 'done', stop: 'end' })}\n\n`));
            ctl.close();
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      return sse({ type: 'text', text: 'Added.' }, { type: 'message', message: { role: 'assistant', content: 'Added.' } }, { type: 'done', stop: 'end' });
    });
    render(<AppProvider><Seed /><Probe /></AppProvider>);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Question' }), { target: { value: 'Add a point at the dam' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const card = await screen.findByRole('group', { name: 'Allow add_point?' });
    expect(card.className).toContain('open');
    expect(within(card).getByRole('timer').textContent).toMatch(/Denied in (10:00|9:5\d) without an answer/);
    await waitFor(() => expect(waiting).toBe(1));
    release();
    expect(await within(card).findByText(/Not answered in time, so add_point was denied\./)).toBeTruthy();
    await waitFor(() => expect(waiting).toBe(0));
    fireEvent.click(await within(card).findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Added.')).toBeTruthy();
    const chats = calls.filter(c => c.url === '/assistant/chat');
    expect(chats).toHaveLength(2);
    expect(chats[1].body.messages.at(-1)).toEqual({ role: 'user', content: 'Add a point at the dam' });
  });

  it('shows Manage usage when the ChatGPT plan limit is reached', async () => {
    server(CHATGPT_ON, [sse({ type: 'error', kind: 'rate_limit', code: 'subscription_sharing_usage_limit_exceeded', message: 'ChatGPT: Usage limit reached.' })]);
    renderTab();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Question' }), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Usage limit reached/);
    expect(within(alert).getByRole('link', { name: 'Manage usage' }).getAttribute('href')).toContain('chatgpt.com/settings/usage');
  });

  it('explains on a shared server that signing in needs your own computer', async () => {
    const hosted = {
      ...STATUS, page_keys: false, providers: [{ ...ANTHROPIC, configured: true, source: 'environment' }],
      sign_in: { allowed: false, reason: 'Signing in works when Bowser runs on your own computer (bowser run, bowser lite or the desktop app); this server uses its own key.', methods: [] },
    };
    server(hosted);
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in or use a key' }));
    expect(screen.getByText(/Signing in works when Bowser runs on your own computer/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Sign in with|Continue with/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Use an API key/ })).toBeNull();
    expect(screen.getByText('This server provides the key.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'how to connect' })).toBeTruthy();
  });
});

/** A server-sent event stream the test feeds one event at a time. */
function liveSse() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
  const enc = new TextEncoder();
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    send: (e: object) => ctl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)),
    end: () => ctl.close(),
  };
}

describe('AssistantTab status line', () => {
  let now = 0;
  beforeEach(() => { now = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now); });
  afterEach(() => { vi.restoreAllMocks(); });
  const line = () => screen.getByRole('status', { name: 'Working' }).textContent;

  it('says which tool runs and for how long, then that the model is thinking, and times each tool', async () => {
    const first = liveSse();
    const second = liveSse();
    server(STATUS, [first.response, second.response]);
    renderTab();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Question' }), { target: { value: 'Is it moving?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(line()).toBe('Thinking… 0 s'));

    // A data tool: its own label, with the seconds ticking.
    now += 1000;
    first.send({ type: 'tool_call', id: 'c1', name: 'point_timeseries', input: { lon: -90.1, lat: 34.75 }, runs: 'server', status: 'Reading the time series' });
    await waitFor(() => expect(line()).toBe('Reading the time series… 0 s'));
    now += 3400;
    await waitFor(() => expect(line()).toBe('Reading the time series… 3 s'), { timeout: 2500 });

    // Its result: back to thinking, and the tool's row shows how long it took.
    first.send({ type: 'tool_result', id: 'c1', name: 'point_timeseries', input: { lon: -90.1, lat: 34.75 }, ok: true, result: null });
    await waitFor(() => expect(line()).toBe('Thinking… 0 s'));
    expect(screen.getByTitle('How long it took').textContent).toBe('3.4 s');

    // A page tool: its label while it runs, then thinking while the next request waits.
    const turn = { role: 'assistant', content: '', tool_calls: [{ id: 'f1', name: 'fly_to', input: { lon: -90.1, lat: 34.75 } }] };
    first.send({ type: 'message', message: turn });
    first.send({ type: 'page_tools', calls: turn.tool_calls, results: [] });
    first.send({ type: 'done', stop: 'page_tools' });
    first.end();
    await waitFor(() => expect(screen.getAllByTitle('How long it took')).toHaveLength(2));
    await waitFor(() => expect(line()).toBe('Thinking… 0 s'));

    // Text: the status line goes.
    second.send({ type: 'text', text: 'It is stable.' });
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Working' })).toBeNull());
    second.send({ type: 'done', stop: 'end' });
    second.end();
    expect(await screen.findByText('It is stable.')).toBeTruthy();
  });

  it("an agent's tool and its thinking say so too", async () => {
    const chat = liveSse();
    const claudeOn = {
      ...STATUS,
      sign_in: { ...SIGN_IN, methods: [{ ...CLAUDE_IN, state: 'signed_in', account: 'me@example.com', plan: 'Max' }, CHATGPT_IN] },
    };
    server(claudeOn, [chat.response], c => (c.url.startsWith('/assistant/agent') ? json({ phase: 'ready', text: 'Ready', elapsed: 2, error: null, note: null }) : null));
    renderTab();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Question' }), { target: { value: 'layers?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(line()).toBe('Claude is thinking… 0 s'));
    chat.send({ type: 'tool_call', id: 't1', name: 'list_layers', input: {}, runs: 'agent', status: 'Listing the layers' });
    await waitFor(() => expect(line()).toBe('Listing the layers… 0 s'));
    now += 400;
    chat.send({ type: 'tool_result', id: 't1', name: 'list_layers', input: {}, ok: true, result: null });
    await waitFor(() => expect(line()).toBe('Claude is thinking… 0 s'));
    expect(screen.getByTitle('How long it took').textContent).toBe('0.4 s');
    chat.send({ type: 'done', stop: 'end' });
    chat.end();
  });
});

function Hidden() {
  return <AssistantTab />;
}
