// API keys in pasted text (BLG-965): which product each one is for and a name for it as a
// variable, so the key can stay in Beluga and the chat carries `$NAME` instead. Only what is
// surely a key counts: a known provider's format, a `SECRET_NAME=value` line, or the same shape as
// a key the project already has. A long random string alone never does, so ordinary pastes (a
// commit hash, a UUID, a log) stay as they are. A prefix and a random body with no format we know
// (`rtl_…`) is asked about softly, as maybe a key (BLG-977). Browser-safe: no Node APIs.
import { keyShapes, suggestName } from './key-shape.js';

/**
 * Why a key was recognised: a provider's format, a NAME=value line, shaped like one of yours, one of
 * yours exactly, shaped like a key with no format we know (asked softly), or picked by you in the box.
 */
export type KeyWhy = 'format' | 'assignment' | 'like-yours' | 'yours' | 'maybe' | 'picked';

export interface FoundKey {
  /** The key as pasted. */
  readonly value: string;
  /** The variable name to keep it under. */
  readonly name: string;
  /** "OpenAI", when the product is known. */
  readonly product?: string;
  /** In words: "an OpenAI API key". */
  readonly what: string;
  readonly why: KeyWhy;
  /** like-yours / yours: the name of the variable it matched. */
  readonly from?: string;
  /** like-yours from another place in Beluga: where that variable is kept ("Ratel", "Everywhere"). */
  readonly fromPlace?: string;
}

/** What the project already has, to name a key the way it does (values stay where they're called from). */
export interface KeyHints {
  /** Variables set there now: name → value. */
  readonly known?: Readonly<Record<string, string>>;
  /** Names the project uses without a value here (its .env.example). */
  readonly names?: readonly string[];
  /** Variables kept in other places in Beluga (other projects, worktrees): a key shaped like one takes its name. */
  readonly elsewhere?: readonly ElsewhereVar[];
  /** Prefixes you said aren't keys (`rtl_`): never asked about as maybe a key again. */
  readonly notKeys?: readonly string[];
}

/** A variable kept somewhere else in Beluga, and where. */
export interface ElsewhereVar {
  readonly name: string;
  readonly value: string;
  readonly place: string;
}

interface Format {
  readonly product: string;
  readonly what: string;
  readonly name: string;
  /** Words a name the project already uses would have for this product ("OPENAI"). */
  readonly words: readonly string[];
  readonly re: RegExp;
  /** A last check on the match (a JWT's role, say). */
  readonly accept?: (value: string) => boolean;
}

// A key starts and ends where a word does: not inside a longer token.
const B = '(?<![A-Za-z0-9_\\-.])';
const E = '(?![A-Za-z0-9_\\-])';
const fmt = (body: string): RegExp => new RegExp(`${B}(${body})${E}`, 'g');

/** Provider formats, most specific first (an Anthropic key is also `sk-…`). */
const FORMATS: readonly Format[] = [
  { product: 'Anthropic', what: 'an Anthropic API key', name: 'ANTHROPIC_API_KEY', words: ['ANTHROPIC', 'CLAUDE'], re: fmt('sk-ant-(?:api|admin|oat)\\d{2}-[A-Za-z0-9_\\-]{80,}') },
  { product: 'OpenRouter', what: 'an OpenRouter API key', name: 'OPENROUTER_API_KEY', words: ['OPENROUTER'], re: fmt('sk-or-v1-[a-f0-9]{64}') },
  { product: 'OpenAI', what: 'an OpenAI API key', name: 'OPENAI_API_KEY', words: ['OPENAI'], re: fmt('sk-(?:proj|svcacct|admin)-[A-Za-z0-9_\\-]{40,}') },
  { product: 'OpenAI', what: 'an OpenAI API key', name: 'OPENAI_API_KEY', words: ['OPENAI'], re: fmt('sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}') },
  { product: 'Stripe', what: 'a Stripe secret key', name: 'STRIPE_SECRET_KEY', words: ['STRIPE'], re: fmt('(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}') },
  { product: 'Stripe', what: 'a Stripe webhook secret', name: 'STRIPE_WEBHOOK_SECRET', words: ['STRIPE_WEBHOOK', 'WEBHOOK'], re: fmt('whsec_[A-Za-z0-9+/=]{24,}') },
  { product: 'GitHub', what: 'a GitHub token', name: 'GITHUB_TOKEN', words: ['GITHUB', 'GH'], re: fmt('gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}') },
  { product: 'GitLab', what: 'a GitLab token', name: 'GITLAB_TOKEN', words: ['GITLAB'], re: fmt('glpat-[A-Za-z0-9_\\-]{20,}') },
  { product: 'AWS', what: 'an AWS access key ID', name: 'AWS_ACCESS_KEY_ID', words: ['AWS_ACCESS_KEY'], re: fmt('(?:AKIA|ASIA)[0-9A-Z]{16}') },
  { product: 'Slack', what: 'a Slack bot token', name: 'SLACK_BOT_TOKEN', words: ['SLACK_BOT', 'SLACK'], re: fmt('xoxb-[0-9]{8,}-[0-9]{8,}-[A-Za-z0-9]{20,}') },
  { product: 'Slack', what: 'a Slack token', name: 'SLACK_TOKEN', words: ['SLACK'], re: fmt('xox[aprs]-[0-9A-Za-z\\-]{30,}|xapp-\\d-[A-Z0-9]+-\\d+-[a-f0-9]{32,}') },
  { product: 'Slack', what: 'a Slack webhook URL', name: 'SLACK_WEBHOOK_URL', words: ['SLACK_WEBHOOK', 'SLACK'], re: /(https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{20,})/g },
  { product: 'Google', what: 'a Google API key (Gemini, Maps, Firebase…)', name: 'GOOGLE_API_KEY', words: ['GEMINI', 'GOOGLE', 'GOOGLE_MAPS', 'FIREBASE'], re: fmt('AIza[0-9A-Za-z_\\-]{35}') },
  { product: 'Groq', what: 'a Groq API key', name: 'GROQ_API_KEY', words: ['GROQ'], re: fmt('gsk_[A-Za-z0-9]{50,}') },
  { product: 'xAI', what: 'an xAI API key', name: 'XAI_API_KEY', words: ['XAI', 'GROK'], re: fmt('xai-[A-Za-z0-9]{70,}') },
  { product: 'Perplexity', what: 'a Perplexity API key', name: 'PERPLEXITY_API_KEY', words: ['PERPLEXITY', 'PPLX'], re: fmt('pplx-[A-Za-z0-9]{40,}') },
  { product: 'Hugging Face', what: 'a Hugging Face token', name: 'HF_TOKEN', words: ['HF', 'HUGGINGFACE', 'HUGGING_FACE'], re: fmt('hf_[A-Za-z]{34,}') },
  { product: 'Replicate', what: 'a Replicate API token', name: 'REPLICATE_API_TOKEN', words: ['REPLICATE'], re: fmt('r8_[A-Za-z0-9]{37}') },
  { product: 'Resend', what: 'a Resend API key', name: 'RESEND_API_KEY', words: ['RESEND'], re: fmt('re_[A-Za-z0-9]{8}_[A-Za-z0-9]{20,32}') },
  { product: 'SendGrid', what: 'a SendGrid API key', name: 'SENDGRID_API_KEY', words: ['SENDGRID'], re: fmt('SG\\.[A-Za-z0-9_\\-]{22}\\.[A-Za-z0-9_\\-]{43}') },
  { product: 'Twilio', what: 'a Twilio API key', name: 'TWILIO_API_KEY', words: ['TWILIO'], re: fmt('SK[0-9a-f]{32}') },
  { product: 'Mailgun', what: 'a Mailgun API key', name: 'MAILGUN_API_KEY', words: ['MAILGUN'], re: fmt('key-[0-9a-f]{32}') },
  { product: 'npm', what: 'an npm token', name: 'NPM_TOKEN', words: ['NPM'], re: fmt('npm_[A-Za-z0-9]{36}') },
  { product: 'PyPI', what: 'a PyPI token', name: 'PYPI_TOKEN', words: ['PYPI'], re: fmt('pypi-[A-Za-z0-9_\\-]{50,}') },
  { product: 'Supabase', what: 'a Supabase secret key', name: 'SUPABASE_SECRET_KEY', words: ['SUPABASE_SECRET', 'SUPABASE_SERVICE'], re: fmt('sb_secret_[A-Za-z0-9_\\-]{20,}') },
  { product: 'Supabase', what: 'a Supabase access token', name: 'SUPABASE_ACCESS_TOKEN', words: ['SUPABASE_ACCESS'], re: fmt('sbp_[a-f0-9]{40}') },
  { product: 'Supabase', what: 'a Supabase service role key', name: 'SUPABASE_SERVICE_ROLE_KEY', words: ['SUPABASE_SERVICE', 'SERVICE_ROLE'], re: fmt('eyJ[A-Za-z0-9_\\-]{10,}\\.eyJ[A-Za-z0-9_\\-]{20,}\\.[A-Za-z0-9_\\-]{20,}'), accept: (v) => jwtClaims(v)?.role === 'service_role' },
  { product: 'Linear', what: 'a Linear API key', name: 'LINEAR_API_KEY', words: ['LINEAR'], re: fmt('lin_api_[A-Za-z0-9]{40}') },
  { product: 'Notion', what: 'a Notion token', name: 'NOTION_TOKEN', words: ['NOTION'], re: fmt('ntn_[A-Za-z0-9]{40,}|secret_[A-Za-z0-9]{43}') },
  { product: 'Shopify', what: 'a Shopify access token', name: 'SHOPIFY_ACCESS_TOKEN', words: ['SHOPIFY'], re: fmt('shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}') },
  { product: 'DigitalOcean', what: 'a DigitalOcean token', name: 'DIGITALOCEAN_TOKEN', words: ['DIGITALOCEAN', 'DO_'], re: fmt('do[por]_v1_[a-f0-9]{64}') },
  { product: 'Sentry', what: 'a Sentry auth token', name: 'SENTRY_AUTH_TOKEN', words: ['SENTRY'], re: fmt('sntry[su]_[A-Za-z0-9+/=_\\-]{40,}') },
  { product: 'PostHog', what: 'a PostHog personal API key', name: 'POSTHOG_PERSONAL_API_KEY', words: ['POSTHOG'], re: fmt('phx_[A-Za-z0-9]{40,}') },
  { product: 'Doppler', what: 'a Doppler token', name: 'DOPPLER_TOKEN', words: ['DOPPLER'], re: fmt('dp\\.(?:pt|st|sa|ct|scim|audit)\\.[A-Za-z0-9]{40,}') },
  { product: 'Postman', what: 'a Postman API key', name: 'POSTMAN_API_KEY', words: ['POSTMAN'], re: fmt('PMAK-[a-f0-9]{24}-[a-f0-9]{34}') },
  { product: 'RevenueCat', what: 'a RevenueCat secret key', name: 'REVENUECAT_SECRET_KEY', words: ['REVENUECAT', 'RC_'], re: fmt('sk_[A-Za-z0-9]{32}') },
  { product: 'ElevenLabs', what: 'an ElevenLabs API key', name: 'ELEVENLABS_API_KEY', words: ['ELEVENLABS', 'ELEVEN', 'XI_'], re: fmt('sk_[a-f0-9]{48}') },
  { product: 'a database', what: 'a database URL with its password', name: 'DATABASE_URL', words: ['DATABASE_URL', 'DB_URL', 'POSTGRES_URL', 'MONGODB_URI', 'REDIS_URL'], re: /((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^:\s/@'"`]+:[^@\s'"`]{3,}@[^\s'"`<>]+)/g, accept: (v) => !/:\[?(YOUR|PASSWORD|password|pass)\]?@/.test(v) },
  { product: 'a private key', what: 'a private key', name: 'PRIVATE_KEY', words: ['PRIVATE_KEY'], re: /(-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----)/g },
];

/** A name that says its value is secret, for NAME=value lines. */
const SECRET_NAME = /(?:^|_)(?:API_?KEY|KEY|SECRET|SECRET_KEY|TOKEN|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|PASSWD|PASS|PWD|PRIVATE_KEY|CLIENT_SECRET|SERVICE_ROLE_KEY|DSN|WEBHOOK_SECRET|SIGNING_SECRET|CREDENTIALS?)$/;
/** Names that end like a secret's and aren't one. */
const NOT_SECRET_NAME = /(?:PUBLIC|PUBLISHABLE|ANON|_ID|_URL|_HOST|_PORT|_PATH|_FILE|_NAME|_TTL|_EXPIRY|_EXPIRES|_LENGTH|_SIZE|_HEADER)(?:_KEY)?$|^(?:NEXT_PUBLIC_|VITE_|EXPO_PUBLIC_|REACT_APP_PUBLIC_)/;
/** NAME=value, NAME: value, export NAME="value", "NAME": "value". */
const ASSIGNMENT = /(?:^|[\s,{;(])(?:export\s+)?["']?([A-Z][A-Z0-9_]{2,63})["']?\s*(?:=|:)\s*(?:"([^"\n]{8,4000})"|'([^'\n]{8,4000})'|`([^`\n]{8,4000})`|([^\s"'`,;}]{8,4000}))/gm;

/** Text that only says what goes there: never a key to keep. */
const PLACEHOLDER = /x{4,}|X{4,}|\*{3,}|•|\.\.\.|…|<[^>]*>|\{\{|\$\{|\[(?:YOUR|your)|your[-_ ]?(?:api|key|token|secret)|(?:^|[^a-z])(?:example|placeholder|changeme|redacted|dummy|sample|test_?key|fake)(?:[^a-z]|$)|^\$[A-Z_]/i;

/** Bits per character over a string's characters: a key's body is high, words and repeats are low. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** A run of one character, or a short run repeated: a placeholder, not a key. */
const repetitive = (s: string): boolean => /(.)\1{5,}/.test(s) || /^(.{1,4})\1{4,}/.test(s.replace(/^[a-z]+[_-]/i, ''));

/** Whether a value could be a real key or password, not a placeholder. */
function realValue(value: string, minBits: number): boolean {
  if (PLACEHOLDER.test(value) || repetitive(value)) return false;
  return entropy(value) >= minBits;
}

/**
 * A NAME=value's value that reads like a password or key, not code: no spaces, not a reference to
 * something else (process.env.X, config.token, a bare camelCase name), and either two kinds of
 * characters (letters and digits, say) or long and random.
 */
function plausibleSecret(name: string, v: string, quoted: boolean): boolean {
  if (/\s/.test(v) || /^(true|false|null|undefined|none|nil|\d+)$/i.test(v)) return false;
  if (/^(process\.env|os\.environ|env\(|import\.meta|getenv|ENV\[)/i.test(v)) return false;
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(v)) return false;
  if (!quoted && (/[()[\]{}<>]/.test(v) || (/^[A-Za-z_$][\w$]*$/.test(v) && !/\d/.test(v)))) return false;
  // Words joined up (user-profile-v2, created_at2, gpt-4o-mini): a cache key or a model, not a secret.
  if (/^[a-z]+(?:[-_.:][a-z0-9]+)+$/i.test(v) && !/\d{3}|[A-Z].*\d.*[a-z]|[a-z].*\d.*[A-Z]/.test(v)) return false;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9_-]/].filter((r) => r.test(v)).length;
  // A password's name says so: a short mixed value is one. A KEY or TOKEN is long and random, or it's a constant.
  if (PASSWORD_NAME.test(name)) return v.length >= 8 && kinds >= 2 && realValue(v, 2.5);
  return v.length >= 16 && (kinds >= 2 ? realValue(v, 3.2) : v.length >= 24 && realValue(v, 3.5));
}
const PASSWORD_NAME = /(?:PASSWORD|PASSWD|PASS|PWD)$/;

/** A JWT's claims (none when it isn't one). */
function jwtClaims(token: string): Record<string, unknown> | undefined {
  const part = token.split('.')[1];
  if (!part) return undefined;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const json = JSON.parse(atob(b64)) as unknown;
    return json && typeof json === 'object' ? (json as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The part a value starts with that says its kind (`sk_live_`, `re_`, `dop_v1_`): none for a bare random string. */
export function keyPrefix(value: string): string | undefined {
  // Only words and version tags count (`sk-proj-`, `dop_v1_`): a random segment (Resend's key id) is the key's own.
  const m = /^([A-Za-z]{1,10}(?:[_\-.](?:[a-z]{2,8}|v\d{1,2})){0,2}[_\-.])(?=[A-Za-z0-9])/.exec(value);
  return m?.[1] && m[1].length >= 3 ? m[1] : undefined;
}

/** What a token is made of: hex, alphanumeric, or with symbols too. */
const charsetOf = (s: string): string => (/^[a-f0-9]+$/.test(s) ? 'hex' : /^[A-Za-z0-9]+$/.test(s) ? 'alnum' : 'mixed');

/** Long tokens in the text that could be someone's key: no spaces, 20+ characters, with a prefix. */
const TOKEN = /(?<![A-Za-z0-9_\-.])([A-Za-z][A-Za-z0-9]{0,9}(?:[_\-.][A-Za-z0-9]{1,8}){0,2}[_\-.][A-Za-z0-9_\-+/=]{16,})(?![A-Za-z0-9_\-])/g;

/** Values of yours shaped like keys (a prefix and a random body), for "like one of yours". */
interface Shape {
  readonly name: string;
  readonly prefix: string;
  readonly length: number;
  readonly charset: string;
  readonly place?: string;
}
function shapesOf(vars: readonly { readonly name: string; readonly value: string; readonly place?: string }[]): Shape[] {
  const out: Shape[] = [];
  for (const { name, value, place } of vars) {
    const prefix = keyPrefix(value);
    if (!prefix || value.length < 20 || /\s/.test(value)) continue;
    const body = value.slice(prefix.length);
    if (!realValue(body, 3)) continue;
    out.push({ name, prefix, length: value.length, charset: charsetOf(body), ...(place ? { place } : {}) });
  }
  return out;
}

/** The name the project already uses for this product, when there's one ("OPENAI_KEY" over OPENAI_API_KEY). */
function projectName(format: Format, names: readonly string[]): string | undefined {
  if (names.includes(format.name)) return format.name;
  const fits = names.filter((n) => format.words.some((w) => n === w || n.startsWith(w.endsWith('_') ? w : `${w}_`) || n.includes(`_${w}_`)) && /(KEY|TOKEN|SECRET|URL|URI|DSN)$/.test(n));
  // The closest in length to the usual name: OPENAI_API_KEY over OPENAI_ORG_ID_KEY.
  return fits.sort((a, b) => Math.abs(a.length - format.name.length) - Math.abs(b.length - format.name.length))[0];
}

/** A provider-shaped match that is a real key: its own check, and a body that isn't a placeholder. */
function formatHolds(format: Format, value: string): boolean {
  if (format.accept && !format.accept(value)) return false;
  if (format.product === 'a private key') return true;
  if (format.product === 'a database') return !PLACEHOLDER.test(value.replace(/^[a-z+]+:\/\//, ''));
  const prefix = keyPrefix(value);
  return realValue(prefix ? value.slice(prefix.length) : value, 3);
}

const PREFIX_WORDS = (p: string): string => p.replace(/[_\-.]+$/, '');

/**
 * Whether pasted text is worth a closer look: a key-like token, a NAME=value line or a private key.
 * Cheap, for every paste; findKeys says what it holds.
 */
export function mayHoldKey(text: string): boolean {
  if (text.length < 16) return false;
  return /[A-Za-z0-9_\-+/=.]{20,}/.test(text) || /PRIVATE KEY-----/.test(text) || /:\/\/[^\s:@/]+:[^\s@]+@/.test(text);
}

/**
 * The API keys in some pasted text, each once, in the order they appear: provider formats first,
 * then NAME=value lines with a secret's name, then tokens shaped like one of `hints.known`. A key
 * that is one of yours already says which. Anything unsure is left out.
 */
export function findKeys(text: string, hints: KeyHints = {}): FoundKey[] {
  const known = hints.known ?? {};
  const names = [...new Set([...Object.keys(known), ...(hints.names ?? [])])];
  const byValue = new Map<string, string>();
  for (const [name, value] of Object.entries(known)) if (value && !byValue.has(value)) byValue.set(value, name);
  const found: { at: number; key: FoundKey }[] = [];
  const seen = new Set<string>();
  const add = (at: number, key: FoundKey): void => {
    if (seen.has(key.value) || [...seen].some((v) => v.includes(key.value))) return;
    seen.add(key.value);
    const yours = byValue.get(key.value);
    found.push({ at, key: yours ? { ...key, name: yours, why: 'yours', from: yours } : key });
  };

  // NAME=value first: the name someone wrote is the best name there is. A provider's key counts
  // under any name; anything else only under a secret's name, and only when it reads like one.
  for (const m of text.matchAll(ASSIGNMENT)) {
    const name = m[1]!;
    const quoted = m[5] === undefined;
    const value = (m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').trim();
    const format = FORMATS.find((f) => new RegExp(`^(?:${f.re.source})$`).test(value) && formatHolds(f, value));
    if (!format && (!SECRET_NAME.test(name) || NOT_SECRET_NAME.test(name) || !plausibleSecret(name, value, quoted))) continue;
    add(m.index ?? 0, { value, name, ...(format ? { product: format.product } : {}), what: format?.what ?? 'a secret value', why: 'assignment' });
  }

  for (const format of FORMATS) {
    for (const m of text.matchAll(format.re)) {
      const value = m[1]!;
      if (!formatHolds(format, value)) continue;
      add(m.index ?? 0, { value, name: projectName(format, names) ?? format.name, product: format.product, what: format.what, why: 'format' });
    }
  }

  // Shaped like a key you have: same prefix and kind of body, about as long. Here first, then
  // anywhere else in Beluga (a Ratel key kept in the Ratel project, pasted in another).
  const elsewhere = (hints.elsewhere ?? []).filter((v) => !byValue.has(v.value));
  const shapes = shapesOf([...Object.entries(known).map(([name, value]) => ({ name, value })), ...elsewhere]);
  if (shapes.length) {
    for (const m of text.matchAll(TOKEN)) {
      const value = m[1]!;
      if (seen.has(value)) continue;
      const prefix = keyPrefix(value);
      if (!prefix) continue;
      const body = value.slice(prefix.length);
      const shape = shapes.find((s) => s.prefix === prefix && Math.abs(s.length - value.length) <= Math.max(2, s.length * 0.15) && charsetOf(body) === s.charset);
      if (!shape || !realValue(body, 3)) continue;
      add(m.index ?? 0, { value, name: shape.name, what: `a key like your ${shape.name}`, why: 'like-yours', from: shape.name, ...(shape.place ? { fromPlace: shape.place } : {}) });
    }
  }

  // Exactly one of yours (no prefix to go by): still kept out of the chat.
  for (const [value, name] of byValue) {
    if (value.length < 16 || seen.has(value) || !realValue(value, 3)) continue;
    const at = text.indexOf(value);
    if (at >= 0) add(at, { value, name, what: `your ${name}`, why: 'yours', from: name });
  }
  // Exactly one kept elsewhere: it isn't set here, so it's kept here too, under the same name.
  for (const v of elsewhere) {
    if (v.value.length < 16 || seen.has(v.value) || !realValue(v.value, 3)) continue;
    const at = text.indexOf(v.value);
    if (at >= 0) add(at, { value: v.value, name: v.name, what: `your ${v.name}`, why: 'like-yours', from: v.name, fromPlace: v.place });
  }

  // Shaped like a key, with no format we know: asked about softly.
  const taken = [...names, ...found.map((f) => f.key.name)];
  for (const shape of keyShapes(text, hints.notKeys)) {
    if (seen.has(shape.value)) continue;
    const name = suggestName(shape.value, taken);
    taken.push(name);
    add(shape.at, { value: shape.value, name, what: 'an API key', why: 'maybe' });
  }

  return found.sort((a, b) => a.at - b.at).map((f) => f.key);
}

/** A key for showing: its kind and last four, the rest dots ("sk-proj-••••3f9a"). */
export function maskKey(value: string): string {
  if (value.startsWith('-----BEGIN')) return value.split('\n')[0] ?? 'Private key';
  const url = /^([a-z+]+:\/\/[^:/]+:)[^@]+(@.*)$/i.exec(value);
  if (url) return `${url[1]}••••${url[2]!.replace(/[?#].*$/, '')}`;
  const prefix = keyPrefix(value);
  // A short secret with no kind to show (a password picked in the box): only its last two.
  if (!prefix && value.length < 20) return `••••${value.slice(-2)}`;
  return `${prefix ?? value.slice(0, Math.min(4, Math.floor(value.length / 4)))}••••${value.slice(-4)}`;
}

/** The text with each key replaced by `$NAME`. A NAME=value line keeps its name: `OPENAI_API_KEY=$OPENAI_API_KEY`. */
export function withKeyRefs(text: string, keys: readonly { readonly value: string; readonly name: string }[]): string {
  // Longest first, so a key inside another (never, but cheaply safe) doesn't split it.
  return [...keys].sort((a, b) => b.value.length - a.value.length).reduce((out, k) => out.split(k.value).join(`$${k.name}`), text);
}

/** "OpenAI" for a found key's chip, or its prefix's word, or "API". */
export const productOf = (key: FoundKey): string => key.product ?? (key.from ? key.from : PREFIX_WORDS(keyPrefix(key.value) ?? 'API'));
