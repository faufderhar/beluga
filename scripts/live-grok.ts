// Live check: Beluga's real Grok Build backend against the real `grok` and your account (a few small prompts on a cheap model).
// Run: npx tsx scripts/live-grok.ts [workdir]   (Grok Build installed and signed in; BELUGA_GROK_PATH to pick one; LIVE_MODEL to pick its model)
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dropGrokSession } from '../src/agent/runtime/grok/sessions.js';
import { createGrokBackend } from '../src/agent/runtime/grok/runner.js';
import { askGrokBtw, grokComplete } from '../src/agent/runtime/grok/side.js';
import { grokStatus } from '../src/agent/runtime/grok/status.js';
import { ToolHost } from '../src/agent/tool-host.js';
import type { AgentPlace, AgentRunInput, RoomBridge, Steer } from '../src/agent/types.js';
import type { StepRecord } from '../src/shared/steps.js';

const ws = path.resolve(process.argv[2] ?? '/tmp/beluga-live-grok');
rmSync(ws, { recursive: true, force: true });
mkdirSync(ws, { recursive: true });
writeFileSync(path.join(ws, 'README.md'), '# Live\nThe magic word is TANGERINE.\n');
writeFileSync(path.join(ws, '.env'), 'API_TOKEN=sk-live-do-not-leak-91827\n');
const MODEL = process.env.LIVE_MODEL ?? 'grok-4.5';

const bridge = { selfName: () => 'kayra', sendChat: () => undefined, listPeers: () => [], askAgent: async () => '', listPeerFiles: async () => [], readPeerFile: async () => '', writeReport: async () => '', reportUsage: () => undefined, getPeerFile: async () => '', sendFile: async () => '' } as unknown as RoomBridge;
const host = new ToolHost({ command: process.execPath, args: [...process.execArgv, path.resolve('src/cli.ts')] });
const backend = createGrokBackend({ cwd: ws, autoEdit: true, additionalDirectories: [], bridge, toolHost: host });

type Run = AgentRunInput & { events: Array<[string, string]>; steps: StepRecord[]; asked: string[]; secrets: string[] };
function input(prompt: string, extra: Partial<AgentRunInput> = {}): Run {
  const events: Array<[string, string]> = [];
  const steps: StepRecord[] = [];
  const asked: string[] = [];
  const secrets: string[] = [];
  return { prompt, requesterName: 'kayra', viaAgent: false, context: [], scope: 'folder', signal: new AbortController().signal, effort: 'low', onEvent: (k: string, t: string) => void events.push([k, t]), onStep: (s: StepRecord) => void steps.push(s), canUseTool: async (name: string) => (asked.push(name), true), canUseSecret: async (name: string) => (secrets.push(name), false), events, steps, asked, secrets, ...extra } as unknown as Run;
}
const sessions: string[] = [];
const place = (extra: Partial<AgentPlace> = {}): AgentPlace => ({ cwd: ws, additionalDirectories: [], autoEdit: true, onSession: (id) => void sessions.push(id), model: MODEL, ...extra });
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  results.push([name, ok, detail]);
  process.stdout.write(`${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  (${detail.slice(0, 160)})` : ''}\n`);
};
const lastTool = (r: Run): StepRecord[] => [...new Map(r.steps.filter((s) => s.kind === 'tool').map((s) => [s.id, s])).values()];

const status = await grokStatus();
check('status: ready with models', status.state === 'ready' && status.models.length > 0, status.models.map((m) => m.value).join(' '));

// A plain read, then a command: the answer streamed, every step asked about, usage said.
const first = input('Read README.md with your file tool, run `ls` once, then answer with just the magic word.');
const said = await backend.run({ ...first, place: place() });
check('answers from a file it read', /TANGERINE/.test(said), said);
check('reads and commands are steps', lastTool(first).length >= 2, lastTool(first).map((s) => s.title).join(' | '));
check('usage event with cost', first.events.some(([k, t]) => k === 'usage' && (JSON.parse(t) as { cost: number }).cost > 0));
check('context meter', first.events.some(([k]) => k === 'context'));
const sid = sessions[0]!;
check('session remembered', Boolean(sid), sid);

// A .env read is turned down by Beluga's gate, and Grok goes on and answers.
const secret = input('Read the file .env with your file tool. If you can, tell me its first letter. If you are refused, answer with exactly REFUSED.');
const refused = await backend.run({ ...secret, place: place({ resume: sid }) });
check('.env read asked as a secret and declined', secret.secrets.length > 0, secret.secrets.join(' '));
check('turn goes on after a refusal', /REFUSED/.test(refused), refused);
check('secret stayed out', !JSON.stringify(secret.events).includes('sk-live-do-not-leak') && !refused.includes('sk-live'));
check('resumed the same session', sessions.at(-1) === sid);

// An edit, then a declined command.
const edit = input('Create notes.txt containing the word hello. Then answer with exactly MADE.');
const made = await backend.run({ ...edit, place: place({ resume: sid }) });
check('writes a file', /hello/.test(readFileSync(path.join(ws, 'notes.txt'), 'utf8')), made);

const declined = input('Run the shell command `echo nope`. If it is refused, answer with exactly DECLINED.', { canUseTool: async () => false });
const no = await backend.run({ ...declined, place: place({ resume: sid }) });
check('a declined command is said and the turn goes on', /DECLINED/.test(no), no);

// Plan: a read-only turn, then approved work.
const planned = input('Plan how to add a file plan.txt containing the word plan, and once approved create it. Keep the plan to one line.', { plan: true, askUser: async () => ({ kind: 'plan', approve: true, feedback: '' }) } as Partial<AgentRunInput>);
await backend.run({ ...planned, place: place() });
let created = '';
try {
  created = readFileSync(path.join(ws, 'plan.txt'), 'utf8');
} catch {
  created = '';
}
check('plan then approve does the work', /plan/.test(created));

// Stop in the middle.
const abort = new AbortController();
let steer: Steer | undefined;
const stopping = input('Run the shell command `sleep 30`, then answer DONE.', { signal: abort.signal, onSteer: (s: Steer | undefined) => void (steer = s ?? steer) });
const running = backend.run({ ...stopping, place: place() });
const t0 = Date.now();
while (Date.now() - t0 < 60_000 && !lastTool(stopping).some((s) => s.status === 'running')) await new Promise((r) => setTimeout(r, 200));
abort.abort();
const stopped = await running.then(() => false, () => true);
check('Stop ends a running step', stopped && Date.now() - t0 < 70_000, `${Date.now() - t0} ms, steer ${typeof steer}`);

// Steer Now: the running turn stops, and the message is answered next.
let hold: Steer | undefined;
const steering = input('Run the shell command `sleep 30`, then answer DONE.', { onSteer: (s: Steer | undefined) => void (hold = s ?? hold) });
const steered = backend.run({ ...steering, place: place() });
const t1 = Date.now();
while (Date.now() - t1 < 60_000 && !lastTool(steering).some((s) => s.status === 'running')) await new Promise((r) => setTimeout(r, 200));
let answered!: (t: string) => void;
let notAnswered!: (e: Error) => void;
const next = new Promise<string>((res, rej) => ((answered = res), (notAnswered = rej)));
const interrupted = await hold!.interrupt!({ prompt: 'Answer with exactly NEXT.', requesterName: 'kayra', viaAgent: false, context: [], onEvent: () => undefined, onDone: answered, onError: (e: string) => notAnswered(new Error(e)) }, 'Stopped to read your message.');
check('Steer Now stops the running turn', interrupted === true && Date.now() - t1 < 70_000, `${Date.now() - t1} ms`);
const nextSaid = await next;
check('the message is answered next', /NEXT/.test(nextSaid), nextSaid);
await steered;

// /compact, /btw, a side call, and a fork.
const compact = input('/compact');
await backend.run({ ...compact, place: place({ resume: sid }) });
check('/compact says so', compact.events.some(([k]) => k === 'compact'));

const btw = await askGrokBtw({ cwd: ws, question: 'What was the magic word? One word.', resume: sid, model: MODEL, onText: () => undefined, signal: new AbortController().signal } as never);
check('/btw knows the conversation', /TANGERINE/.test(btw), btw);

const named = await grokComplete({ prompt: 'Add a dark mode toggle', system: 'Answer with a two-word title for this task, nothing else.', cwd: ws, model: MODEL });
check('a side call answers', named.trim().length > 0, named);

const forkRun = input('From this conversation only, with no tools: what was the magic word? One word.');
const forked = await backend.run({ ...forkRun, place: place({ resume: sid, forkSession: true }) });
check('fork knows the conversation', /TANGERINE/.test(forked), forked);
check('fork is a new session', sessions.at(-1) !== sid);

await Promise.all([...new Set(sessions)].map((s) => dropGrokSession(s)));
const failed = results.filter(([, ok]) => !ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length ? 1 : 0);
