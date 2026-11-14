// A project's .env.example, kept in step with its .env and .env.local (BLG-925): the same names,
// with a placeholder for each value that says what goes there (`sk_live_…`, `postgres://USER:PASSWORD@…`)
// and never a secret's body. The file is committed, so a placeholder only keeps what is safe to
// publish: a known token prefix, a plain flag or port, a URL's scheme and host. Browser-safe.
import { type EnvVar, parseEnvText } from './env-vars.js';

/** The template files a project may have, the first one there used. */
export const EXAMPLE_FILES = ['.env.example', '.env.sample', '.env.template'] as const;
export const DEFAULT_EXAMPLE_FILE = EXAMPLE_FILES[0];

const ELLIPSIS = '…';

/** A name that says its value is a secret: its value is never kept, not even a plain-looking one. */
const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|PASS|PWD|PIN|PRIVATE|CREDENTIAL|AUTH|SALT|SIGNATURE|SIGNING|COOKIE|SESSION|(^|_)KEY($|_)|APIKEY|DSN)/i;

/** Plain values a template can show as they are (outside a secret's name). */
const PLAIN_WORDS = /^(true|false|yes|no|on|off|0|1|development|production|staging|preview|test|local|dev|prod|debug|info|warn|warning|error|trace|silent|none|auto)$/i;
const PORT_OR_COUNT = /^\d{1,5}$/;
const HOSTS_KEPT = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', 'host.docker.internal']);

/**
 * Token prefixes that say which kind of key goes there, from services people put in .env files.
 * Anything else that looks like `word_` + a long random tail keeps a short lowercase prefix too.
 */
const KNOWN_PREFIXES = [
  'sk_live_', 'sk_test_', 'pk_live_', 'pk_test_', 'rk_live_', 'rk_test_', 'whsec_', 'acct_',
  'sk-ant-', 'sk-proj-', 'sk-',
  'ghp_', 'gho_', 'ghs_', 'ghu_', 'github_pat_', 'glpat-',
  'xoxb-', 'xoxp-', 'xapp-',
  'phc_', 'phx_', 'sntrys_', 'sntryu_', 'npm_', 'pypi-', 'dop_v1_', 're_', 'SG.', 'AKIA', 'AIza', 'hf_', 'lin_api_', 'pplx-', 'gsk_', 'xai-', 'sbp_', 'shpat_', 'shpss_',
] as const;
const GENERIC_PREFIX = /^([a-z]{2,8}(?:[_-][a-z]{2,8}){0,2}[_-])([A-Za-z0-9+/=_-]{16,})$/;
/** A random-looking tail: long, and with digits or mixed case. */
const looksRandom = (s: string): boolean => s.length >= 16 && (/\d/.test(s) || (/[a-z]/.test(s) && /[A-Z]/.test(s)));

const kebab = (key: string): string => key.toLowerCase().replace(/_+/g, '-').replace(/^-|-$/g, '');

/** A URL with its user and password replaced, and only the scheme and host kept (all of it on this computer's own hosts). */
function urlPlaceholder(value: string): string | undefined {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:([^@/?#]*)@)?([^/?#:]+|\[[^\]]+\])(:\d+)?([^?#]*)?/i.exec(value);
  if (!m) return undefined;
  const [, scheme, userinfo, host = '', port = '', rest = ''] = m;
  const who = userinfo ? (userinfo.includes(':') ? 'USER:PASSWORD@' : 'USER@') : '';
  if (HOSTS_KEPT.has(host.replace(/^\[|\]$/g, ''))) return `${scheme}://${who}${host}${port}${rest}`;
  // A project ref as a subdomain (abcdefghijklmnopqrst.supabase.co) says whose it is: a stand-in for it.
  const labels = host.split('.');
  const shown = labels.map((l, i) => (i < labels.length - 2 && l.length >= 12 ? 'your-project' : l)).join('.');
  const more = rest && rest !== '/' ? `/${ELLIPSIS}` : '';
  return `${scheme}://${who}${shown}${port}${more}`;
}

/**
 * What a template shows for one variable: enough to say what goes there, nothing that would work.
 * `true`, `3000`, `development` and a localhost URL stay; a token keeps its kind (`sk_live_…`);
 * a URL keeps its scheme and host; anything else is `your-<name>`.
 */
export function placeholderFor(key: string, value: string): string {
  const v = value.trim();
  if (!v) return '';
  const secret = SECRET_NAME.test(key);
  if (!secret && (PLAIN_WORDS.test(v) || PORT_OR_COUNT.test(v))) return v;
  const url = urlPlaceholder(v);
  if (url) return url;
  const known = KNOWN_PREFIXES.find((p) => v.startsWith(p) && v.length >= p.length + 8);
  if (known) return `${known}${ELLIPSIS}`;
  if (v.startsWith('eyJ') && v.length > 30) return `eyJ${ELLIPSIS}`;
  const generic = GENERIC_PREFIX.exec(v);
  if (generic?.[1] && generic[2] && looksRandom(generic[2]) && !/PASS|PWD|PIN/i.test(key)) return `${generic[1]}${ELLIPSIS}`;
  if (!secret && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v)) return 'you@example.com';
  return `your-${kebab(key)}`;
}

/** The names a template lists. */
export const exampleKeys = (text: string): string[] => parseEnvText(text).vars.map((v) => v.key);

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

export interface ExampleSync {
  readonly text: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/**
 * A template with these variables added (a placeholder each, after its last line) and these names
 * taken out. Every other line, comment and hand-written example stays as it is.
 */
export function syncExample(text: string, add: readonly EnvVar[], remove: readonly string[] = []): ExampleSync {
  const listed = new Set(exampleKeys(text));
  const gone = new Set(remove.filter((k) => listed.has(k)));
  const lines = text ? text.split('\n') : [];
  const kept = gone.size ? lines.filter((line) => !gone.has(KEY_LINE.exec(line)?.[1] ?? '')) : lines;
  const seen = new Set<string>();
  const fresh = add.filter((v) => !listed.has(v.key) && !seen.has(v.key) && seen.add(v.key));
  if (!fresh.length && !gone.size) return { text, added: [], removed: [] };
  // The file's own last empty line goes after what's added.
  const body = kept.length && kept[kept.length - 1] === '' ? kept.slice(0, -1) : kept;
  const next = [...body, ...fresh.map((v) => `${v.key}=${placeholderFor(v.key, v.value)}`)].join('\n');
  return { text: next ? `${next}\n` : '', added: fresh.map((v) => v.key), removed: [...gone] };
}
