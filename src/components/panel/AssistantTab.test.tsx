/** The Assistant tab: providers and keys, a streamed conversation whose tools act on the page, errors, and the off state. */
import { useEffect } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
const ANTHROPIC = provider({ id: 'anthropic', label: 'Anthropic', wire: 'anthropic', model: 'claude-opus-5-5', models: ['claude-opus-5-5'], key_url: 'https://console.anthropic.com/settings/keys' });
const OLLAMA = provider({ id: 'ollama', label: 'Ollama (local)', model: 'qwen3', needs_key: false, local: true, auth: 'none', configured: true });
const CHATGPT = provider({ id: 'chatgpt', label: 'Sign in with ChatGPT', wire: 'responses', auth: 'sign_in', available: false, note: 'Coming in a later version.' });
const STATUS = { enabled: true, page_keys: true, default_provider: null, providers: [ANTHROPIC, OLLAMA, CHATGPT] };

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
    const saved = { ...STATUS, stored_in: 'the system keychain', providers: [{ ...ANTHROPIC, configured: true, source: 'saved', hint: '…abcd', store: 'keyring' }, OLLAMA, CHATGPT] };
    const calls = server(STATUS, [], c => {
      if (c.url === '/assistant/key' && c.method === 'PUT') return json(saved);
      if (c.url.startsWith('/assistant/key') && c.method === 'DELETE') return json(STATUS);
      return null;
    });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Provider and key' }));
    const select = screen.getByRole('combobox', { name: 'Provider' }) as HTMLSelectElement;
    // ChatGPT sign-in is listed, not offered yet.
    const chatgpt = within(select).getByRole('option', { name: /Sign in with ChatGPT/ }) as HTMLOptionElement;
    expect(chatgpt.disabled).toBe(true);
    // A local provider takes no key and no base URL: nothing to set up.
    expect(screen.queryByLabelText('API key')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Base URL' })).toBeNull();
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    expect(screen.getByText(/installed with Ollama on the computer that runs Bowser/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Get Ollama/ })).toBeNull();

    fireEvent.change(select, { target: { value: 'anthropic' } });
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLInputElement).value).toBe('claude-opus-5-5');
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
    expect(screen.getByRole('link', { name: 'how to connect' }).getAttribute('href')).toContain('docs/mcp.md');

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByLabelText('API key')).toBeTruthy();
    expect(calls.some(c => c.method === 'DELETE' && c.url === '/assistant/key?provider=anthropic')).toBe(true);
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
    expect(first.messages[0].content).toMatch(/^\[page: \{"layer":"displacement"/);
    expect(first.messages[0].content).toMatch(/Is the dam crest moving\?$/);
    expect(first.page_tools.map((t: { name: string }) => t.name)).toEqual(
      expect.arrayContaining(['fly_to', 'add_point', 'set_reference_point', 'set_reference_date', 'switch_layer', 'open_chart', 'add_overlay']));
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

function Hidden() {
  return <AssistantTab />;
}
