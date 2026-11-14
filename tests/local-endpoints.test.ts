import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRunInput, FollowUp } from '../src/agent/types.js';
import { endpointEnv, missedWords, onEndpoint, usageMeter } from '../src/agent/runtime/local.js';
import { cleanSettings, endpointClaudeHome, prepareEndpointHome } from '../src/agent/runtime/endpoint-home.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { EnvVars } from '../src/core/env-vars.js';
import { LocalEndpoints } from '../src/core/local-endpoints.js';
import { Store, initialState } from '../src/core/store.js';
import { agentPicker } from '../src/shared/agent-picker.js';
import { runtimeChoices } from '../src/shared/agent-runtimes.js';
import { OLLAMA_URL, endpointIdFor, localModelValue, localModels, localWhy, parseLocalModel, speedWords, tokensPerSecond } from '../src/shared/local-endpoints.js';

const tmpFile = (): string => path.join(mkdtempSync(path.join(os.tmpdir(), 'beluga-local-')), 'env.json');

/** A fetch that answers per address: a model list, a status, or nothing (down). */
function fakeFetch(answers: Record<string, unknown>): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    const a = Object.entries(answers).find(([k]) => u.startsWith(k))?.[1];
    if (a === undefined) throw new Error('ECONNREFUSED');
    if (typeof a === 'number') return new Response('no', { status: a });
    return new Response(JSON.stringify(a), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('local endpoints: model values', () => {
  it('names an endpoint and its model, the model keeping its own slashes and colons', () => {
    expect(localModelValue('ollama', 'qwen3-coder:30b')).toBe('ollama/qwen3-coder:30b');
    expect(parseLocalModel('ollama/hf.co/unsloth/x:Q4')).toEqual({ id: 'ollama', model: 'hf.co/unsloth/x:Q4' });
    for (const bad of [undefined, '', 'sonnet', '/x', 'ollama/', 'Bad Id/x']) expect(parseLocalModel(bad)).toBeUndefined();
    expect(endpointIdFor('Work proxy', [])).toBe('work-proxy');
    expect(endpointIdFor('Ollama', ['ollama'])).toBe('ollama-2');
  });

  it('lists Ollama first, greys one that is not answering, and says answers depend on the model', () => {
    const rows = localModels([
      { id: 'proxy', label: 'Work proxy', models: ['big'], reachable: false },
      { id: 'ollama', label: 'Ollama', models: [], found: ['qwen3-coder'], reachable: true },
    ]);
    expect(rows.map((r) => r.value)).toEqual(['ollama/qwen3-coder', 'proxy/big']);
    expect(rows[0]!.why).toBeUndefined();
    expect(rows[0]!.description).toMatch(/depend on the model/);
    expect(rows[1]!.why).toBe("Work proxy isn't answering.");
    expect(localWhy([])).toMatch(/Ollama/);
  });
});

describe('local endpoints: kept like your other secrets', () => {
  it('saves to env.json readable only by you, keeps the key on edit, and never publishes it', () => {
    const file = tmpFile();
    const store = new Store(initialState('t'));
    const env = new EnvVars({ store, file });
    const id = env.saveEndpoint({ label: 'Work proxy', baseUrl: 'https://llm.example.com/', key: 'sk-secret', models: ['big', ' big ', 'small'] });
    expect(id).toBe('work-proxy');
    expect(env.endpoints()[0]).toEqual({ id, label: 'Work proxy', baseUrl: 'https://llm.example.com', key: 'sk-secret', models: ['big', 'small'] });
    // Windows has no Unix modes: the user profile's own ACL keeps it private there.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    env.saveEndpoint({ id, label: 'Proxy', baseUrl: 'https://llm.example.com' });
    expect(env.endpoints()[0]).toMatchObject({ label: 'Proxy', key: 'sk-secret', models: ['big', 'small'] });
    env.saveEndpoint({ id, label: 'Proxy', baseUrl: 'https://llm.example.com', key: '' });
    expect(env.endpoints()[0]!.key).toBeUndefined();
    expect(() => env.saveEndpoint({ label: 'x', baseUrl: 'ftp://nope' })).toThrow();
    expect(JSON.stringify(store.getState())).not.toContain('llm.example.com');
    // A fresh read (another Beluga, a restart) finds it.
    expect(JSON.parse(readFileSync(file, 'utf8')).endpoints).toHaveLength(1);
    env.removeEndpoint(id);
    expect(env.endpoints()).toEqual([]);
  });
});

describe('local endpoints: alive', () => {
  it('finds Ollama on this Mac without being added, and only shows it in the picker when it answers', async () => {
    const onChange = vi.fn();
    let up = false;
    const fetch = vi.fn((url: string) => (up ? fakeFetch({ [OLLAMA_URL]: { data: [{ id: 'qwen3-coder' }] } })(url) : Promise.reject(new Error('down')))) as unknown as typeof globalThis.fetch;
    const local = new LocalEndpoints({ endpoints: () => [], onChange, fetch });
    await local.look();
    expect(local.choices()).toEqual([]);
    expect(local.views()[0]).toMatchObject({ id: 'ollama', builtIn: true, reachable: false });
    up = true;
    await local.look();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(local.choices()).toEqual([{ id: 'ollama', label: 'Ollama', models: [], reachable: true, found: ['qwen3-coder'], builtIn: true }]);
    expect(local.resolve('ollama/qwen3-coder')).toEqual({ id: 'ollama', label: 'Ollama', baseUrl: OLLAMA_URL, model: 'qwen3-coder' });
    // Nothing changed: not told again.
    await local.look();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('counts any answer as answering, reads Ollama’s own list, and sends the key only to its endpoint', async () => {
    const fetch = fakeFetch({ 'https://proxy.example.com': 401, 'http://box:11434/v1/models': 404, 'http://box:11434/api/tags': { models: [{ name: 'llama3.3' }] } });
    const local = new LocalEndpoints({
      endpoints: () => [
        { id: 'proxy', label: 'Proxy', baseUrl: 'https://proxy.example.com', key: 'k1', models: ['m'] },
        { id: 'box', label: 'Ollama on box', baseUrl: 'http://box:11434', models: [] },
        { id: 'ollama', label: 'Ollama', baseUrl: OLLAMA_URL, models: ['qwen3-coder'] },
      ],
      fetch,
    });
    await local.look();
    const views = local.views();
    expect(views.map((v) => [v.id, v.reachable, v.found])).toEqual([
      ['proxy', true, []],
      ['box', true, ['llama3.3']],
      ['ollama', false, []],
    ]);
    // Yours there: no built-in Ollama besides it. Views never carry a key.
    expect(views.some((v) => v.builtIn)).toBe(false);
    expect(JSON.stringify(views)).not.toContain('k1');
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
    for (const [url, init] of calls) expect(Boolean((init.headers as Record<string, string>)['x-api-key'])).toBe(url.startsWith('https://proxy.example.com'));
    expect(localModels(local.choices()).find((m) => m.value === 'ollama/qwen3-coder')?.why).toMatch(/Ollama isn't answering/);
  });

  it('puts the Local group in the picker with its models, or greyed saying to start Ollama', () => {
    const state = { runtimes: [], models: [], prefs: {}, projects: [{ workspaces: [{ id: 'w1', agent: { runtime: 'local', label: 'Local model' }, model: 'ollama/qwen3-coder' }] }] };
    const off = runtimeChoices((id) => (id === 'claude' ? {} : undefined));
    expect(off.find((r) => r.id === 'local')).toMatchObject({ available: false });
    const on = runtimeChoices((id) => (id === 'claude' ? {} : id === 'local' ? { models: localModels([{ id: 'ollama', label: 'Ollama', models: ['qwen3-coder'], reachable: true }]) } : undefined));
    const picker = agentPicker({ ...state, runtimes: on }, 'ws:w1');
    expect(picker.runtime).toBe('local');
    expect(picker.label).toBe('Local model · Ollama · qwen3-coder');
    expect(picker.groups.find((g) => g.runtime === 'local')?.models[0]).toMatchObject({ on: true, value: 'ollama/qwen3-coder' });
  });
});

describe('local endpoints: a run', () => {
  const target = { label: 'Ollama', baseUrl: OLLAMA_URL, model: 'qwen3-coder' };

  it('points Claude Code at the endpoint, every model alias at its model, and keeps your Claude login off it', () => {
    const env = endpointEnv(target);
    expect(env).toMatchObject({ ANTHROPIC_BASE_URL: OLLAMA_URL, ANTHROPIC_AUTH_TOKEN: 'ollama', ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_SMALL_FAST_MODEL: 'qwen3-coder', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3-coder', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
    // Nothing only Anthropic's API takes: no tool search, no inline tools (DeepSeek answers 422).
    expect(env).toMatchObject({ ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_INLINE_TOOLS: 'false' });
    expect(endpointEnv({ ...target, key: 'sk-1' }).ANTHROPIC_AUTH_TOKEN).toBe('sk-1');
    // Claude Code runs in its own folder there, where it finds no Claude sign-in to send instead of the key.
    expect(endpointEnv(target, '/tmp/endpoint-claude').CLAUDE_CONFIG_DIR).toBe('/tmp/endpoint-claude');
    expect(endpointEnv(target).CLAUDE_CONFIG_DIR).toMatch(/claude-endpoint$/);
  });

  it('its Claude Code folder is yours, linked, without your sign-in; conversations land in yours', () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'endpoint-home-')));
    const mine = path.join(root, 'claude');
    const into = path.join(root, 'endpoint');
    mkdirSync(path.join(mine, 'projects'), { recursive: true });
    mkdirSync(path.join(mine, 'skills', 'review'), { recursive: true });
    writeFileSync(path.join(mine, 'settings.json'), '{"hooks":{}}');
    writeFileSync(path.join(mine, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"sk-ant-oat"}}');
    writeFileSync(path.join(mine, '.claude.json'), '{"primaryApiKey":"sk-ant-api"}');
    // A link to your .claude.json from before is taken out too.
    mkdirSync(into, { recursive: true });
    if (process.platform !== 'win32') symlinkSync(path.join(mine, '.claude.json'), path.join(into, '.claude.json'));
    expect(endpointClaudeHome(mine, into)).toBe(into);
    expect(readdirSync(into).sort()).toEqual(['projects', 'settings.json', 'skills']);
    expect(lstatSync(path.join(into, 'projects')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(path.join(into, 'settings.json'), 'utf8'))).toEqual({ hooks: {} });
    // A conversation Claude Code writes there is in your own projects folder, where Beluga reads it.
    writeFileSync(path.join(into, 'projects', 'run.jsonl'), '{}');
    expect(existsSync(path.join(mine, 'projects', 'run.jsonl'))).toBe(true);
    // Something gone from yours goes from it; a sign-in put there is taken out.
    rmSync(path.join(mine, 'skills'), { recursive: true });
    writeFileSync(path.join(into, '.credentials.json'), '{}');
    endpointClaudeHome(mine, into);
    expect(readdirSync(into).sort()).toEqual(['projects', 'settings.json']);
    // The .claude.json Claude Code writes there is its own, and stays.
    writeFileSync(path.join(into, '.claude.json'), '{"numStartups":1}');
    endpointClaudeHome(mine, into);
    expect(readFileSync(path.join(into, '.claude.json'), 'utf8')).toBe('{"numStartups":1}');
    rmSync(path.join(into, '.claude.json'));
    // Your settings come as a copy: a run that rewrites it there changes nothing of yours, and the next run brings yours back.
    expect(lstatSync(path.join(into, 'settings.json')).isSymbolicLink()).toBe(false);
    writeFileSync(path.join(into, 'settings.json'), '{"stale":true}');
    expect(readFileSync(path.join(mine, 'settings.json'), 'utf8')).toBe('{"hooks":{}}');
    endpointClaudeHome(mine, into);
    expect(JSON.parse(readFileSync(path.join(into, 'settings.json'), 'utf8'))).toEqual({ hooks: {} });
  });

  it('its settings never carry a key helper or a key variable, and a link to yours from before becomes the cleaned copy', () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'endpoint-settings-')));
    const mine = path.join(root, 'claude');
    const into = path.join(root, 'endpoint');
    mkdirSync(mine, { recursive: true });
    mkdirSync(into, { recursive: true });
    const yours = {
      model: 'opus',
      apiKeyHelper: '~/bin/anthropic-key',
      awsAuthRefresh: 'aws sso login',
      awsCredentialExport: '~/bin/aws-creds',
      env: { ANTHROPIC_API_KEY: 'sk-ant-api', ANTHROPIC_AUTH_TOKEN: 'sk-ant-x', ANTHROPIC_BASE_URL: 'https://api.anthropic.com', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CONFIG_DIR: '/x', EDITOR: 'vim' },
      hooks: { Stop: [] },
    };
    writeFileSync(path.join(mine, 'settings.json'), JSON.stringify(yours));
    if (process.platform !== 'win32') symlinkSync(path.join(mine, 'settings.json'), path.join(into, 'settings.json'));
    expect(prepareEndpointHome(mine, into)).toEqual({ dir: into, missed: [] });
    expect(lstatSync(path.join(into, 'settings.json')).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(path.join(into, 'settings.json'), 'utf8'))).toEqual({ model: 'opus', env: { EDITOR: 'vim' }, hooks: { Stop: [] } });
    // Yours stays as you wrote it.
    expect(JSON.parse(readFileSync(path.join(mine, 'settings.json'), 'utf8'))).toEqual(yours);
    expect(cleanSettings({ env: 'odd', apiKeyHelper: 'x' })).toEqual({ env: 'odd' });
  });

  it('what of yours could not come along is named, and the rest still comes', () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'endpoint-missed-')));
    const mine = path.join(root, 'claude');
    const into = path.join(root, 'endpoint');
    mkdirSync(path.join(mine, 'agents'), { recursive: true });
    writeFileSync(path.join(mine, 'settings.json'), '{ not json');
    const home = prepareEndpointHome(mine, into);
    expect(home.missed).toEqual(['settings.json']);
    expect(lstatSync(path.join(into, 'agents')).isSymbolicLink()).toBe(true);
    // A folder that can't be made at all says so too.
    writeFileSync(path.join(root, 'a-file'), '');
    expect(prepareEndpointHome(mine, path.join(root, 'a-file', 'endpoint')).missed).toEqual(['your Claude Code folder']);
    // The run says it, in words.
    const said: Array<[string, string]> = [];
    const input = { prompt: 'hi', onEvent: (kind: string, text: string) => said.push([kind, text]) } as unknown as AgentRunInput;
    const run = onEndpoint(input, target, () => undefined, usageMeter(), home);
    expect(run.env).toMatchObject({ CLAUDE_CONFIG_DIR: into });
    expect(said).toEqual([['progress', missedWords(['settings.json'])]]);
    expect(missedWords(['settings.json'])).toContain('settings.json');
    // Nothing missed, nothing said.
    onEndpoint(input, target, () => undefined, usageMeter(), { dir: into, missed: [] });
    expect(said).toHaveLength(1);
  });

  it('runs on the model’s own name, its env over yours, no effort, and maps a model picked mid-run', () => {
    const sent: FollowUp[] = [];
    let send: ((f: FollowUp) => boolean) | undefined;
    const input = { prompt: 'hi', model: 'ollama/qwen3-coder', effort: 'high', env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', MINE: '1' }, onFollowUps: (s: typeof send) => (send = s) } as unknown as AgentRunInput;
    const resolve = (v: string | undefined) => (v === 'ollama/llama3.3' ? { ...target, model: 'llama3.3' } : v === 'proxy/big' ? { label: 'P', baseUrl: 'https://p', model: 'big' } : undefined);
    const run = onEndpoint(input, target, resolve, usageMeter(), { dir: '/tmp/endpoint-claude', missed: [] });
    expect(run.model).toBe('qwen3-coder');
    expect(run.effort).toBeUndefined();
    expect(run.env).toMatchObject({ MINE: '1', ANTHROPIC_BASE_URL: OLLAMA_URL });
    run.onFollowUps!((f) => (sent.push(f), true));
    send!({ prompt: 'a', model: 'ollama/llama3.3' } as FollowUp);
    send!({ prompt: 'b', model: 'proxy/big' } as FollowUp);
    expect(sent.map((f) => f.model)).toEqual(['llama3.3', undefined]);
  });
});

describe('local endpoints: tokens and speed instead of a quota (BLG-450)', () => {
  it('makes a local run free and says how fast each turn wrote, from the running totals', () => {
    let t = 1_000;
    const meter = usageMeter(() => t);
    t += 10_000;
    const first = JSON.parse(meter.map(JSON.stringify({ input: 5000, output: 420, cost: 0.41, session: 's1' })));
    expect(first).toMatchObject({ input: 5000, output: 420, cost: 0, free: true, tps: 42 });
    // The next turn: only what grew counts, over the time since it began.
    meter.begin();
    t += 4_000;
    expect(JSON.parse(meter.map(JSON.stringify({ output: 437, cost: 0.5, session: 's1' })))).toMatchObject({ cost: 0, tps: 4.3 });
    expect(tokensPerSecond(10, 100)).toBeUndefined();
    expect(speedWords(42)).toBe('free · 42 tok/s');
    expect(speedWords(undefined)).toBe('free');
  });

  it('turns a local run’s usage events through the meter, a follow-up’s too', () => {
    const seen: string[] = [];
    let send: ((f: FollowUp) => boolean) | undefined;
    const input = { prompt: 'hi', model: 'ollama/q', onEvent: (k: string, x: string) => k === 'usage' && seen.push(x), onFollowUps: (s: typeof send) => (send = s) } as unknown as AgentRunInput;
    const run = onEndpoint(input, { label: 'Ollama', baseUrl: OLLAMA_URL, model: 'q' }, () => undefined);
    run.onEvent('usage', JSON.stringify({ output: 1, cost: 1 }));
    const later: string[] = [];
    run.onFollowUps!((f) => (f.onEvent('usage', JSON.stringify({ output: 2, cost: 2 })), true));
    send!({ prompt: 'b', onEvent: (_k: string, x: string) => later.push(x) } as unknown as FollowUp);
    expect([...seen, ...later].map((x) => JSON.parse(x).cost)).toEqual([0, 0]);
  });

  it('keeps a local workspace’s speed, with no cost', async () => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-local-usage-')));
    const store = new WorkspaceStore(path.join(base, 'home'));
    store.saveConfig({ roots: [], projects: [], hidden: [] });
    const mgr = new WorkspaceManager(store);
    await mgr.refresh();
    const chat = await mgr.createChat('chats', 'local');
    mgr.addUsage(chat.id, { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, session: 's', free: true, tps: 9 });
    const u = mgr.addUsage(chat.id, { input: 200, output: 60, cacheRead: 0, cacheWrite: 0, cost: 0, session: 's', free: true });
    expect(u).toMatchObject({ input: 200, output: 60, cost: 0, local: { tps: 9 } });
  });
});
