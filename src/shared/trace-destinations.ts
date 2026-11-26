/**
 * Your own traces (BLG-1014): observability tools you connect yourself, which get your agents' turns
 * as OpenTelemetry `gen_ai` spans (the same spans usage statistics are built from, src/telemetry/turn.ts),
 * for every runtime. Separate from Beluga's own usage statistics: these go to your accounts, with
 * your keys, whatever that level is.
 *
 * Each tool says what it needs pasted in and how that becomes its OTLP/HTTP traces URL and headers.
 * Ratel first. Browser-safe: no Node, so Settings reads the same list.
 */

export type TraceFieldKind = 'secret' | 'text' | 'url' | 'choice';

export interface TraceField {
  readonly key: string;
  readonly label: string;
  readonly kind: TraceFieldKind;
  readonly placeholder?: string;
  /** Left empty: fine (a default is used, or the tool picks). */
  readonly optional?: boolean;
  readonly choices?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  /** What a choice starts at. */
  readonly initial?: string;
}

/** Where one tool takes traces: its URL, the headers it wants and the resource attributes it reads. */
export interface TraceTarget {
  readonly traces: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly resource?: Readonly<Record<string, string>>;
}

export interface TraceProvider {
  readonly id: TraceProviderId;
  readonly name: string;
  /** Whose product it is, when that's how people know it ("LangChain"). */
  readonly by?: string;
  /** Its website, for people who don't know it yet (none: not a product). */
  readonly site?: string;
  /** Where the key is, in the tool's own words. */
  readonly where: string;
  /** Its own page for sending OpenTelemetry. */
  readonly docs: string;
  readonly fields: readonly TraceField[];
  /** Other words people search for it by. */
  readonly keywords?: string;
  /**
   * It takes any well-formed trace at once and checks the key later (PostHog: its project keys are
   * public), so a wrong key is never refused: Send Test can say only that the trace went.
   */
  readonly checksKeyLater?: boolean;
  /** Its target from the fields, or an error in plain words. Fields are already trimmed. */
  readonly target: (f: Readonly<Record<string, string>>) => TraceTarget | { readonly error: string };
}

export const TRACE_PROVIDER_IDS = ['ratel', 'braintrust', 'posthog', 'langsmith', 'arize', 'logfire', 'sentry', 'newrelic', 'datadog', 'langfuse', 'databricks', 'otlp'] as const;
export type TraceProviderId = (typeof TRACE_PROVIDER_IDS)[number];

/** Field keys: letters only (they're kept as JSON keys in env.json). */
export const TRACE_FIELD_KEY = /^[a-zA-Z]{1,24}$/;
/** A field's value is at most this long (a header list, a long token). */
export const TRACE_FIELD_MAX = 4_000;

const region = (choices: ReadonlyArray<readonly [string, string]>, initial: string): TraceField => ({
  key: 'region',
  label: 'Region',
  kind: 'choice',
  choices: choices.map(([value, label]) => ({ value, label })),
  initial,
});
const US_EU = region([['us', 'US'], ['eu', 'EU']], 'us');

const secret = (key: string, label: string, placeholder?: string): TraceField => ({ key, label, kind: 'secret', ...(placeholder ? { placeholder } : {}) });

/** An https address, or http on this computer (a collector or Phoenix of your own); no trailing slash. */
export function cleanUrl(raw: string | undefined): string | undefined {
  const u = (raw ?? '').trim().replace(/\/+$/, '');
  if (!u) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return undefined;
  }
  const local = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(parsed.hostname);
  if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && local)) return u;
  return undefined;
}

/** A host, with or without https:// ("dbc-1234.cloud.databricks.com"), as an https base. */
function hostBase(raw: string | undefined): string | undefined {
  const t = (raw ?? '').trim();
  if (!t) return undefined;
  const u = cleanUrl(/^https?:\/\//.test(t) ? t : `https://${t}`);
  return u ? new URL(u).origin : undefined;
}

/** Base64 of UTF-8 text, in a browser and in Node (never throws, unlike btoa on non-Latin-1). */
const base64 = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

const need = (f: Readonly<Record<string, string>>, ...keys: string[]): string | undefined => {
  const missing = keys.find((k) => !f[k]);
  return missing;
};

/** "name=value" or "name: value", one a line (or comma-separated): headers for any OTLP endpoint. */
export function parseHeaders(raw: string | undefined): Record<string, string> | { readonly error: string } {
  const out: Record<string, string> = {};
  const lines = (raw ?? '').split(/\r?\n|,(?=\s*[\w-]+\s*[=:])/);
  for (const [i, line] of lines.entries()) {
    const t = line.trim();
    if (!t) continue;
    const m = /^([A-Za-z0-9-_.]{1,80})\s*[=:]\s*(.+)$/.exec(t);
    // Its words are never repeated: a header line may hold a key.
    if (!m) return { error: `Header ${i + 1} isn’t name=value` };
    out[m[1]!.toLowerCase()] = m[2]!.trim();
  }
  return out;
}

/**
 * A Sentry DSN as its OTLP traces endpoint: `https://<key>@o<org>.ingest.<region>.sentry.io/<project>`
 * → `https://o<org>.ingest.<region>.sentry.io/api/<project>/integration/otlp/v1/traces`.
 */
export function sentryTarget(dsn: string): TraceTarget | { readonly error: string } {
  let u: URL;
  try {
    u = new URL(dsn.trim());
  } catch {
    return { error: 'Paste the whole DSN: https://…@….ingest.sentry.io/…' };
  }
  const project = u.pathname.replace(/^\/+|\/+$/g, '').split('/').pop();
  if (u.protocol !== 'https:' || !u.username || !project || !/^\d+$/.test(project)) return { error: 'That doesn’t look like a DSN: https://<key>@<host>/<project number>' };
  return {
    traces: `https://${u.host}/api/${project}/integration/otlp/v1/traces`,
    headers: { 'x-sentry-auth': `sentry sentry_key=${u.username}` },
  };
}

export const TRACE_PROVIDERS: readonly TraceProvider[] = [
  {
    id: 'ratel',
    name: 'Ratel Cloud',
    site: 'https://www.ratel.sh',
    where: 'Your project’s Settings › API keys on cloud.ratel.sh',
    docs: 'https://www.ratel.sh/docs/platform/send-data/opentelemetry',
    keywords: 'ratel cloud badger',
    fields: [secret('key', 'API key', 'rtl_…')],
    target: (f) => (f.key ? { traces: 'https://cloud.ratel.sh/v1/traces', headers: { authorization: `Bearer ${f.key}` } } : { error: 'Paste your project’s API key' }),
  },
  {
    id: 'braintrust',
    name: 'Braintrust',
    site: 'https://www.braintrust.dev',
    where: 'Settings › API keys on braintrust.dev',
    docs: 'https://www.braintrust.dev/docs/integrations/sdk-integrations/opentelemetry',
    fields: [secret('key', 'API key', 'sk-…'), { key: 'project', label: 'Project', kind: 'text', placeholder: 'My project' }, US_EU],
    target: (f) =>
      need(f, 'key', 'project')
        ? { error: 'Paste your API key and the project’s name' }
        : { traces: `https://api${f.region === 'eu' ? '-eu' : ''}.braintrust.dev/otel/v1/traces`, headers: { authorization: `Bearer ${f.key}`, 'x-bt-parent': `project_name:${f.project}` } },
  },
  {
    id: 'posthog',
    name: 'PostHog',
    site: 'https://posthog.com',
    where: 'Project settings › Project API key on posthog.com',
    docs: 'https://posthog.com/docs/llm-analytics/installation/opentelemetry',
    keywords: 'llm analytics hedgehog',
    checksKeyLater: true,
    fields: [secret('key', 'Project API key', 'phc_…'), US_EU],
    target: (f) => (f.key ? { traces: `https://${f.region === 'eu' ? 'eu' : 'us'}.i.posthog.com/i/v0/ai/otel`, headers: { authorization: `Bearer ${f.key}` } } : { error: 'Paste your project API key' }),
  },
  {
    id: 'langsmith',
    name: 'LangSmith',
    by: 'LangChain',
    site: 'https://www.langchain.com/langsmith',
    where: 'Settings › API Keys on smith.langchain.com',
    docs: 'https://docs.langchain.com/langsmith/trace-with-opentelemetry',
    keywords: 'langchain langgraph',
    fields: [secret('key', 'API key', 'lsv2_…'), { key: 'project', label: 'Project', kind: 'text', placeholder: 'default', optional: true }, region([['us', 'US'], ['eu', 'EU'], ['apac', 'APAC']], 'us')],
    target: (f) =>
      f.key
        ? {
            traces: `https://${f.region === 'eu' || f.region === 'apac' ? `${f.region}.` : ''}api.smith.langchain.com/otel/v1/traces`,
            headers: { 'x-api-key': f.key, ...(f.project ? { 'langsmith-project': f.project } : {}) },
          }
        : { error: 'Paste your API key' },
  },
  {
    id: 'arize',
    name: 'Arize',
    site: 'https://arize.com',
    where: 'Space settings › API Keys on app.arize.com',
    docs: 'https://arize.com/docs/ax/integrations/platforms/claude-managed-agents/claude-managed-agents-tracing',
    keywords: 'phoenix arize ax openinference',
    fields: [
      secret('key', 'API key'),
      { key: 'space', label: 'Space ID', kind: 'text', placeholder: 'U3BhY2U6…', optional: true },
      { key: 'project', label: 'Project', kind: 'text', placeholder: 'beluga', optional: true },
      region([['us', 'US'], ['eu', 'EU'], ['phoenix', 'Phoenix']], 'us'),
      { key: 'url', label: 'Phoenix address', kind: 'url', placeholder: 'Only for Phoenix: http://localhost:6006', optional: true },
    ],
    target: (f) => {
      const project = f.project || 'beluga';
      const resource = { 'openinference.project.name': project, model_id: project };
      if (f.region === 'phoenix') {
        const base = cleanUrl(f.url);
        if (!base) return { error: 'Your Phoenix’s address: https://… (or http:// on this computer)' };
        const headers: Record<string, string> = { 'x-project-name': project, ...(f.key ? { authorization: `Bearer ${f.key}` } : {}) };
        return { traces: base.endsWith('/v1/traces') ? base : `${base}/v1/traces`, headers, resource };
      }
      if (need(f, 'key', 'space')) return { error: 'Paste your API key and space ID' };
      // Arize's pages name these headers two ways; it reads either.
      return {
        traces: `https://otlp${f.region === 'eu' ? '.eu-west-1a' : ''}.arize.com/v1/traces`,
        headers: { 'arize-api-key': f.key!, 'arize-space-id': f.space!, api_key: f.key!, space_id: f.space!, 'x-project-name': project },
        resource,
      };
    },
  },
  {
    id: 'logfire',
    name: 'Logfire',
    by: 'Pydantic',
    site: 'https://pydantic.dev/logfire',
    where: 'Your project’s Settings › Write tokens on logfire.pydantic.dev',
    docs: 'https://pydantic.dev/docs/logfire/how-to-guides/alternative-clients/',
    keywords: 'pydantic logfire',
    fields: [secret('key', 'Write token', 'pylf_v1_…'), US_EU],
    target: (f) => (f.key ? { traces: `https://logfire-${f.region === 'eu' ? 'eu' : 'us'}.pydantic.dev/v1/traces`, headers: { authorization: f.key } } : { error: 'Paste a write token' }),
  },
  {
    id: 'sentry',
    name: 'Sentry',
    site: 'https://sentry.io',
    where: 'Project settings › Client Keys (DSN) on sentry.io',
    docs: 'https://docs.sentry.io/concepts/otlp/',
    fields: [secret('dsn', 'DSN', 'https://…@o123.ingest.us.sentry.io/456')],
    target: (f) => (f.dsn ? sentryTarget(f.dsn) : { error: 'Paste your project’s DSN' }),
  },
  {
    id: 'newrelic',
    name: 'New Relic',
    site: 'https://newrelic.com',
    where: 'API keys › INGEST - LICENSE on one.newrelic.com',
    docs: 'https://docs.newrelic.com/docs/opentelemetry/best-practices/opentelemetry-otlp/',
    keywords: 'newrelic nr',
    fields: [secret('key', 'License key'), region([['us', 'US'], ['eu', 'EU'], ['jp', 'Japan']], 'us')],
    target: (f) => (f.key ? { traces: `https://otlp.${f.region === 'eu' ? 'eu01.' : f.region === 'jp' ? 'jp.' : ''}nr-data.net/v1/traces`, headers: { 'api-key': f.key } } : { error: 'Paste an ingest license key' }),
  },
  {
    id: 'datadog',
    name: 'Datadog',
    site: 'https://www.datadoghq.com',
    where: 'Organization settings › API keys on datadoghq.com',
    docs: 'https://docs.datadoghq.com/llm_observability/instrument/otel_instrumentation/',
    keywords: 'dd llm observability apm',
    fields: [
      secret('key', 'API key'),
      region(
        [
          ['datadoghq.com', 'US1'],
          ['us3.datadoghq.com', 'US3'],
          ['us5.datadoghq.com', 'US5'],
          ['datadoghq.eu', 'EU'],
          ['ap1.datadoghq.com', 'AP1'],
          ['ap2.datadoghq.com', 'AP2'],
          ['uk1.datadoghq.com', 'UK1'],
        ],
        'datadoghq.com',
      ),
      { key: 'app', label: 'ML app', kind: 'text', placeholder: 'beluga', optional: true },
    ],
    target: (f) => {
      if (!f.key) return { error: 'Paste an API key' };
      const site = /^([a-z0-9]+\.)?datadoghq\.(com|eu)$/.test(f.region ?? '') ? f.region : 'datadoghq.com';
      return {
        traces: `https://otlp.${site}/v1/traces`,
        headers: { 'dd-api-key': f.key, 'dd-otlp-source': 'llmobs', 'dd-llmobs-enabled': 'true', 'dd-ml-app': f.app || 'beluga' },
        // Its ML app is the service's name.
        resource: { dd_llmobs_enabled: 'true', 'service.name': f.app || 'beluga' },
      };
    },
  },
  {
    id: 'langfuse',
    name: 'Langfuse',
    site: 'https://langfuse.com',
    where: 'Project settings › API Keys on cloud.langfuse.com',
    docs: 'https://langfuse.com/integrations/native/opentelemetry',
    fields: [
      { key: 'publicKey', label: 'Public key', kind: 'text', placeholder: 'pk-lf-…' },
      secret('key', 'Secret key', 'sk-lf-…'),
      region([['eu', 'EU'], ['us', 'US'], ['jp', 'Japan'], ['hipaa', 'HIPAA'], ['self', 'My own']], 'eu'),
      { key: 'url', label: 'Address', kind: 'url', placeholder: 'Only for your own: https://langfuse.example.com', optional: true },
    ],
    target: (f) => {
      if (need(f, 'publicKey', 'key')) return { error: 'Paste the public and the secret key' };
      const base = f.region === 'self' ? cleanUrl(f.url) : f.region && f.region !== 'eu' ? `https://${f.region}.cloud.langfuse.com` : 'https://cloud.langfuse.com';
      if (!base) return { error: 'Your Langfuse’s address: https://…' };
      // Version 4: traces show at once, not minutes later.
      return { traces: `${base}/api/public/otel/v1/traces`, headers: { authorization: `Basic ${base64(`${f.publicKey}:${f.key}`)}`, 'x-langfuse-ingestion-version': '4' } };
    },
  },
  {
    id: 'databricks',
    name: 'Databricks',
    site: 'https://www.databricks.com',
    where: 'The token: Settings › Developer › Access tokens. The table: Catalog Explorer › your schema › the one ending in _otel_spans, once an MLflow experiment stores its traces there',
    docs: 'https://docs.databricks.com/aws/en/mlflow3/genai/tracing/trace-unity-catalog',
    keywords: 'mlflow unity catalog lakehouse',
    fields: [
      { key: 'host', label: 'Workspace', kind: 'url', placeholder: 'dbc-1234.cloud.databricks.com' },
      secret('key', 'Access token', 'dapi…'),
      { key: 'table', label: 'Spans table', kind: 'text', placeholder: 'catalog.schema.beluga_otel_spans' },
    ],
    target: (f) => {
      const base = hostBase(f.host);
      if (!base) return { error: 'Your workspace’s address: dbc-….cloud.databricks.com' };
      if (need(f, 'key', 'table')) return { error: 'Paste an access token and the spans table' };
      return { traces: `${base}/api/2.0/otel/v1/traces`, headers: { authorization: `Bearer ${f.key}`, 'x-databricks-uc-table-name': f.table! } };
    },
  },
  {
    id: 'otlp',
    name: 'Another OTLP endpoint',
    where: 'Your collector’s or tool’s own settings',
    docs: 'https://opentelemetry.io/docs/specs/otlp/#otlphttp',
    keywords: 'opentelemetry collector otel grafana tempo jaeger honeycomb custom',
    fields: [
      { key: 'url', label: 'Traces address', kind: 'url', placeholder: 'https://collector.example.com/v1/traces' },
      { key: 'headers', label: 'Headers', kind: 'secret', placeholder: 'authorization=Bearer …', optional: true },
    ],
    target: (f) => {
      const url = cleanUrl(f.url);
      if (!url) return { error: 'An https:// address (or http:// on this computer)' };
      const headers = parseHeaders(f.headers);
      if ('error' in headers) return { error: String(headers.error) };
      return { traces: /\/v1\/traces$/.test(url) ? url : `${url}/v1/traces`, headers };
    },
  },
];

export const traceProvider = (id: string): TraceProvider | undefined => TRACE_PROVIDERS.find((p) => p.id === id);

/** Its fields, trimmed, with each choice at its default when not picked. */
export function traceFields(provider: TraceProvider, raw: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of provider.fields) {
    const v = (raw[field.key] ?? '').trim() || (field.kind === 'choice' ? (field.initial ?? '') : '');
    if (v) out[field.key] = v;
  }
  return out;
}

/** A destination's target, or what's wrong with it. */
export function traceTarget(id: string, raw: Readonly<Record<string, string>>): TraceTarget | { readonly error: string } {
  const provider = traceProvider(id);
  if (!provider) return { error: 'Beluga doesn’t know that tool' };
  try {
    return provider.target(traceFields(provider, raw));
  } catch {
    return { error: 'Something in it doesn’t look right' };
  }
}

/** The fields that say where its keys go (an address, a workspace): changing one asks for the keys again. */
export function whereFields(provider: TraceProvider): string[] {
  return provider.fields.filter((f) => f.kind === 'url').map((f) => f.key);
}

/**
 * What's typed over what's saved: a secret left empty keeps the saved one, unless an address it
 * would go to changed (then it's typed again, so a key never follows a new address unasked).
 */
export function mergeTraceFields(provider: TraceProvider, saved: Readonly<Record<string, string>>, typed: Readonly<Record<string, string>>): Record<string, string> {
  const moved = whereFields(provider).some((k) => (typed[k] ?? saved[k] ?? '').trim() !== (saved[k] ?? '').trim());
  const out: Record<string, string> = {};
  for (const f of provider.fields) {
    const given = typed[f.key];
    const v = f.kind === 'secret' && !given?.trim() ? (moved ? '' : (saved[f.key] ?? '')) : (given ?? saved[f.key] ?? '');
    if (v.trim()) out[f.key] = v;
  }
  return out;
}

/** How a destination is doing, as Settings shows it. */
export type TraceState = 'off' | 'waiting' | 'sending' | 'refused' | 'failing' | 'invalid';

/** One destination as a screen sees it: never a secret, only which are saved. */
export interface TraceDestinationView {
  readonly id: TraceProviderId;
  readonly on: boolean;
  /** Your prompts, answers and tools' input and output go too (masked). */
  readonly text: boolean;
  /** Its fields that aren't secret, as typed. */
  readonly fields: Readonly<Record<string, string>>;
  /** Its secret fields that have a value. */
  readonly saved: readonly string[];
  readonly state: TraceState;
  /** When a batch last went (epoch ms). */
  readonly lastSentAt?: number;
  /** What's wrong, in plain words (state refused, failing or invalid). */
  readonly problem?: string;
}

/** What Send Test found. */
export interface TraceTestResult {
  readonly ok: boolean;
  readonly words: string;
}
