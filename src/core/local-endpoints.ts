/**
 * Your local and bring-your-own endpoints (BLG-449), alive: which answer, and the models they say
 * they have. Kept in env.json with your other secrets (env-vars.ts); this looks at them now and then
 * so the picker can grey one that isn't answering. Ollama on this Mac counts without being added
 * while you have none of your own there. A run asks `resolve` for the endpoint a model value names.
 */
import { type EndpointChoice, type EndpointFormat, type EndpointView, OLLAMA_ID, OLLAMA_URL, openaiUrl, parseLocalModel } from '../shared/local-endpoints.js';
import type { Endpoint } from './env-vars.js';

/** What a run on an endpoint needs: where, the key (if any) and the model's own name. */
export interface ResolvedEndpoint {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly key?: string;
  readonly model: string;
  readonly format?: EndpointFormat;
}

export interface LocalEndpointsDeps {
  readonly endpoints: () => readonly Endpoint[];
  /** What it found changed (the picker's runtimes are worth publishing again). */
  readonly onChange?: () => void;
  readonly fetch?: typeof fetch;
  /** How long one look waits (default 2.5 s). */
  readonly timeoutMs?: number;
}

/** How often endpoints are looked at again. */
const EVERY_MS = 30_000;
/** A model value is at most 64 characters (protocol.ts AgentRef). */
const MAX_VALUE = 64;

const OLLAMA: Endpoint = { id: OLLAMA_ID, label: 'Ollama', baseUrl: OLLAMA_URL, models: [] };

interface Seen {
  readonly reachable: boolean;
  readonly found: readonly string[];
}

export class LocalEndpoints {
  private readonly seen = new Map<string, Seen>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private looking: Promise<void> | undefined;

  constructor(private readonly deps: LocalEndpointsDeps) {}

  /** Yours, and Ollama on this Mac while none of yours is. */
  private all(): readonly (Endpoint & { readonly builtIn?: boolean })[] {
    const own = this.deps.endpoints();
    const ollamaThere = own.some((e) => e.id === OLLAMA_ID || e.baseUrl.replace(/\/+$/, '') === OLLAMA_URL);
    return ollamaThere ? own : [...own, { ...OLLAMA, builtIn: true }];
  }

  private seenOf(e: Endpoint): Seen | undefined {
    return this.seen.get(seenKey(e));
  }

  /** For Settings: every endpoint with its URL, never its key. */
  views(): EndpointView[] {
    return this.all().map((e) => {
      const seen = this.seenOf(e);
      return { id: e.id, label: e.label, baseUrl: e.baseUrl, ...(e.format === 'openai' ? { format: e.format } : {}), hasKey: Boolean(e.key), models: e.models, ...(seen ? { reachable: seen.reachable, found: seen.found } : {}), ...(e.builtIn ? { builtIn: true } : {}) };
    });
  }

  /** For the picker: yours (answering or not), and Ollama on this Mac only when it answers. No URL, no key. */
  choices(): EndpointChoice[] {
    return this.all().flatMap((e) => {
      const seen = this.seenOf(e);
      if (e.builtIn && !seen?.reachable) return [];
      return [{ id: e.id, label: e.label, models: e.models, ...(seen ? { reachable: seen.reachable, found: seen.found } : {}), ...(e.builtIn ? { builtIn: true } : {}) }];
    });
  }

  /** The endpoint and model a picked value names, for a run. */
  resolve(value: string | undefined): ResolvedEndpoint | undefined {
    const parsed = parseLocalModel(value);
    const e = parsed && this.all().find((x) => x.id === parsed.id);
    if (!parsed || !e) return undefined;
    return { id: e.id, label: e.label, baseUrl: e.baseUrl, ...(e.key ? { key: e.key } : {}), model: parsed.model, ...(e.format === 'openai' ? { format: e.format } : {}) };
  }

  /** Look now and every 30 seconds. */
  start(): void {
    void this.look();
    this.timer ??= setInterval(() => void this.look(), EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Look at every endpoint once (one look at a time); tells onChange when something changed. */
  look(): Promise<void> {
    this.looking ??= (async () => {
      const before = JSON.stringify([...this.seen]);
      const all = this.all();
      const results = await Promise.all(all.map(async (e) => [e, await this.lookAt(e)] as const));
      this.seen.clear();
      for (const [e, seen] of results) this.seen.set(seenKey(e), seen);
      if (JSON.stringify([...this.seen]) !== before) this.deps.onChange?.();
    })().finally(() => {
      this.looking = undefined;
    });
    return this.looking;
  }

  /** Any answer at all is "answering" (a 401 says the key is wrong, not that it's down); its models when it lists them. */
  private async lookAt(e: Endpoint): Promise<Seen> {
    const fit = (names: readonly string[]): string[] => [...new Set(names)].filter((m) => m && e.id.length + 1 + m.length <= MAX_VALUE).slice(0, 40);
    const v1 = await this.get(e.format === 'openai' ? openaiUrl(e.baseUrl, 'models') : `${e.baseUrl}/v1/models`, e.key);
    if (!v1) return { reachable: false, found: [] };
    const listed = namesIn(v1.body);
    if (listed.length || e.format === 'openai') return { reachable: true, found: fit(listed) };
    // Ollama's own list, for an Ollama that doesn't list on /v1/models.
    const tags = await this.get(`${e.baseUrl}/api/tags`, e.key);
    return { reachable: true, found: fit(tags ? namesIn(tags.body) : []) };
  }

  private async get(url: string, key: string | undefined): Promise<{ status: number; body: unknown } | undefined> {
    const f = this.deps.fetch ?? fetch;
    try {
      const res = await f(url, { headers: key ? { 'x-api-key': key, authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(this.deps.timeoutMs ?? 2500) });
      const body = res.ok ? await res.json().catch(() => undefined) : undefined;
      return { status: res.status, body };
    } catch {
      return undefined;
    }
  }
}

const seenKey = (e: Endpoint): string => `${e.id}|${e.baseUrl}|${e.key ? 'k' : ''}|${e.format ?? ''}`;

/** Model names in an OpenAI/Anthropic-style list ({ data: [{ id }] }) or Ollama's ({ models: [{ name }] }). */
function namesIn(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const b = body as { data?: unknown; models?: unknown };
  const rows = Array.isArray(b.data) ? b.data : Array.isArray(b.models) ? b.models : [];
  return rows.flatMap((r) => {
    const name = r && typeof r === 'object' ? ((r as { id?: unknown; name?: unknown }).id ?? (r as { name?: unknown }).name) : undefined;
    return typeof name === 'string' ? [name] : [];
  });
}
