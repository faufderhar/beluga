import { describe, expect, it } from 'vitest';
import { findKeys, keyPrefix, maskKey, mayHoldKey, withKeyRefs } from '../src/shared/key-detect.js';
import { keyShapes, looksLikeKey, suggestName } from '../src/shared/key-shape.js';

/** A random-looking string from a fixed seed (the same every run), in an alphabet. */
function rand(n: number, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', seed = n * 7919): string {
  let x = seed;
  let out = '';
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += alphabet[(x >>> 16) % alphabet.length];
  }
  return out;
}
const HEX = '0123456789abcdef';

const OPENAI = `sk-proj-${rand(48)}_${rand(40, undefined, 3)}`;
const ANTHROPIC = `sk-ant-api03-${rand(93)}-${rand(6, undefined, 5)}AA`;
const STRIPE = `sk_live_${rand(99)}`;
const GITHUB = `ghp_${rand(36)}`;
// Put together when the test runs: a whole key in the source would stop GitHub's push protection.
const AWS = `${'AKIA'}Q3EGUW5VJ7XZPLMN`;
const GOOGLE = `AIza${rand(35, undefined, 11)}`;
const jwt = (payload: object): string => `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${btoa(JSON.stringify(payload)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.${rand(43, undefined, 17)}`;

describe('findKeys: provider formats', () => {
  it.each([
    [OPENAI, 'OpenAI', 'OPENAI_API_KEY'],
    [ANTHROPIC, 'Anthropic', 'ANTHROPIC_API_KEY'],
    [STRIPE, 'Stripe', 'STRIPE_SECRET_KEY'],
    [`whsec_${rand(32)}`, 'Stripe', 'STRIPE_WEBHOOK_SECRET'],
    [GITHUB, 'GitHub', 'GITHUB_TOKEN'],
    [AWS, 'AWS', 'AWS_ACCESS_KEY_ID'],
    [GOOGLE, 'Google', 'GOOGLE_API_KEY'],
    [`xoxb-123456789012-1234567890123-${rand(24)}`, 'Slack', 'SLACK_BOT_TOKEN'],
    [`gsk_${rand(52)}`, 'Groq', 'GROQ_API_KEY'],
    [`hf_${rand(34, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz')}`, 'Hugging Face', 'HF_TOKEN'],
    [`re_${rand(8)}_${rand(24, undefined, 9)}`, 'Resend', 'RESEND_API_KEY'],
    [`npm_${rand(36)}`, 'npm', 'NPM_TOKEN'],
    [`sk-or-v1-${rand(64, HEX)}`, 'OpenRouter', 'OPENROUTER_API_KEY'],
    [`lin_api_${rand(40)}`, 'Linear', 'LINEAR_API_KEY'],
    [jwt({ iss: 'supabase', ref: 'abcdefghijklmnop', role: 'service_role', iat: 1700000000 }), 'Supabase', 'SUPABASE_SERVICE_ROLE_KEY'],
    [`postgresql://postgres:${rand(16)}@db.abcdefghijklmnop.supabase.co:5432/postgres`, 'a database', 'DATABASE_URL'],
  ])('%s', (value, product, name) => {
    const found = findKeys(`can you wire this up? ${value} thanks`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ value, product, name, why: 'format' });
  });

  it('finds several in one paste, in order, each once', () => {
    const found = findKeys(`stripe: ${STRIPE}\nopenai ${OPENAI}\nagain ${STRIPE}`);
    expect(found.map((k) => k.name)).toEqual(['STRIPE_SECRET_KEY', 'OPENAI_API_KEY']);
  });

  it('a private key, whole', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${rand(64)}\n${rand(64, undefined, 2)}\n-----END RSA PRIVATE KEY-----`;
    expect(findKeys(`here:\n${pem}\n`)).toMatchObject([{ value: pem, name: 'PRIVATE_KEY' }]);
  });

  it('an Anthropic key is not also an OpenAI one', () => {
    expect(findKeys(ANTHROPIC).map((k) => k.product)).toEqual(['Anthropic']);
  });
});

describe('findKeys: NAME=value', () => {
  it('keeps the name someone wrote', () => {
    const found = findKeys(`MY_OPENAI=${OPENAI}\nexport PAYMENTS_SECRET="${rand(20)}"\nPORT=3000\nNODE_ENV=production`);
    expect(found.map((k) => [k.name, k.why])).toEqual([
      ['MY_OPENAI', 'assignment'],
      ['PAYMENTS_SECRET', 'assignment'],
    ]);
    expect(found[0]!.product).toBe('OpenAI');
  });

  it('a .env with public keys and settings: only the secrets', () => {
    const env = [`NEXT_PUBLIC_SUPABASE_ANON_KEY=${jwt({ role: 'anon', iss: 'supabase' })}`, `SUPABASE_SERVICE_ROLE_KEY=${jwt({ role: 'service_role', iss: 'supabase' })}`, 'STRIPE_PUBLISHABLE_KEY=pk_live_51Habcdefghijk', 'SESSION_SECRET=Tr0ub4dor&3horse9q', 'DB_PASSWORD=hunter22'].join('\n');
    expect(findKeys(env).map((k) => k.name)).toEqual(['SUPABASE_SERVICE_ROLE_KEY', 'SESSION_SECRET', 'DB_PASSWORD']);
  });

  it('code that reads a secret is not one', () => {
    const code = ["const CACHE_KEY = 'user-profile-v2';", 'SORT_KEY=created_at2', 'PRIMARY_KEY: users_id1', 'KEY=abc123def', 'const MAX_TOKEN = "gpt-4o-mini";', 'const API_KEY = process.env.API_KEY;', 'TOKEN = someVariable', 'SECRET_KEY = config.secrets.key', 'const AUTH_TOKEN = getToken();', 'PASSWORD: string', 'API_KEY=${API_KEY}', 'API_KEY=$OPENAI_API_KEY'].join('\n');
    expect(findKeys(code)).toEqual([]);
  });
});

describe('findKeys: never a false alarm', () => {
  it.each([
    ['a commit hash', 'fixed in 3f9a2c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39'],
    ['a UUID', 'session 550e8400-e29b-41d4-a716-446655440000 expired'],
    ['a path', '/Users/kayra/Projects/beluga/src/core/env-vars.ts:420'],
    ['prose', 'People usually paste their API keys into the chat just to ask whether it works.'],
    ['a placeholder', 'OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'],
    ['a docs placeholder', 'STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key_here'],
    ['angle brackets', 'export GITHUB_TOKEN=<your-github-token>'],
    ['a template', 'DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/app'],
    ['Supabase Connect', 'postgresql://postgres:[YOUR-PASSWORD]@db.abcdefghijklmnop.supabase.co:5432/postgres'],
    ['an anon JWT', jwt({ role: 'anon', iss: 'supabase' })],
    ['a base64 image', `data:image/png;base64,${rand(120)}`],
    ['a long URL', `https://example.com/callback?state=${rand(40)}&code=${rand(30, undefined, 4)}`],
    ['a dotted secret with no prefix', `the build id is ${rand(48)}`],
    ['a masked key', 'sk-proj-••••••••3f9a'],
    ['too short', 'sk_live_abc123'],
    ['a log line', '2026-11-14T10:00:00.000Z INFO request_id=4f2a9c8e7b1d took 12ms'],
  ])('%s', (_label, text) => {
    expect(findKeys(text)).toEqual([]);
  });
});

describe('findKeys: the project’s own keys', () => {
  const known = { BILLING_KEY: `bk_live_${rand(32)}`, OPENAI_KEY: `sk-proj-${rand(60, undefined, 21)}`, LEGACY_TOKEN: rand(40, undefined, 33) };

  it('one of yours exactly: named after it, nothing new to keep', () => {
    const found = findKeys(`use ${known.BILLING_KEY} please`, { known });
    expect(found).toMatchObject([{ name: 'BILLING_KEY', why: 'yours', from: 'BILLING_KEY' }]);
  });

  it('one of yours with no prefix, exactly', () => {
    expect(findKeys(`token ${known.LEGACY_TOKEN}`, { known })).toMatchObject([{ name: 'LEGACY_TOKEN', why: 'yours' }]);
  });

  it('shaped like one of yours: same prefix and body, about as long', () => {
    const other = `bk_live_${rand(32, undefined, 99)}`;
    expect(findKeys(`new one: ${other}`, { known })).toMatchObject([{ value: other, name: 'BILLING_KEY', why: 'like-yours' }]);
  });

  it('a different length or body is not like yours', () => {
    expect(findKeys(`bk_live_${rand(12, undefined, 5)}abcdefgh`, { known })).toEqual([]);
    // Hex where yours is letters: not like yours (it's only maybe a key).
    expect(findKeys(`bk_live_${rand(32, HEX, 5)}`, { known: { BILLING_KEY: `bk_live_${rand(32, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz')}` } }).map((k) => k.why)).toEqual(['maybe']);
  });

  it('a provider key takes the name the project uses for it', () => {
    expect(findKeys(OPENAI, { known })[0]?.name).toBe('OPENAI_KEY');
    expect(findKeys(GOOGLE, { names: ['GEMINI_API_KEY', 'PORT'] })[0]?.name).toBe('GEMINI_API_KEY');
    expect(findKeys(STRIPE, { names: ['STRIPE_PUBLISHABLE_KEY_ID', 'STRIPE_SECRET_KEY'] })[0]?.name).toBe('STRIPE_SECRET_KEY');
  });
});

describe('helpers', () => {
  it('mayHoldKey: cheap, and false for short or plain text', () => {
    expect(mayHoldKey('hello there')).toBe(false);
    expect(mayHoldKey(`key ${OPENAI}`)).toBe(true);
  });

  it('maskKey shows the kind and the last four', () => {
    expect(maskKey(STRIPE)).toBe(`sk_live_••••${STRIPE.slice(-4)}`);
    expect(maskKey('postgres://u:hunter22@db.example.com/app?ssl=1')).toBe('postgres://u:••••@db.example.com/app');
    expect(maskKey(AWS)).toBe(`AKIA••••${AWS.slice(-4)}`);
    expect(maskKey('Hunter2Staging')).toBe('••••ng');
  });

  it('withKeyRefs swaps each key for $NAME, and a NAME=value keeps its name', () => {
    const text = `OPENAI_API_KEY=${OPENAI}\nand stripe ${STRIPE}`;
    expect(withKeyRefs(text, [{ value: OPENAI, name: 'OPENAI_API_KEY' }, { value: STRIPE, name: 'STRIPE_SECRET_KEY' }])).toBe('OPENAI_API_KEY=$OPENAI_API_KEY\nand stripe $STRIPE_SECRET_KEY');
  });

  it('keyPrefix', () => {
    expect(keyPrefix('sk_live_abc')).toBe('sk_live_');
    expect(keyPrefix('dop_v1_abcdef')).toBe('dop_v1_');
    expect(keyPrefix(rand(30))).toBeUndefined();
    expect(keyPrefix(`re_${'Kd8Pq2Wx'}_7bN4mL1zR9cT6vY3hJ0fG5sQw`)).toBe('re_');
  });
});

// BLG-977: keys with no format we know.
const RATEL = `rtl_${'k6RdVk9lLghguXqcpxATMBfV00FPbQPV'}`;

describe('findKeys: maybe a key', () => {
  it('a short prefix and a random body is asked about softly, named after its prefix', () => {
    expect(findKeys(`here is the key ${RATEL} thanks`)).toMatchObject([{ value: RATEL, name: 'RTL_API_KEY', why: 'maybe', what: 'an API key' }]);
  });

  it('long hex after a prefix too', () => {
    const hex = `acme-${rand(40, HEX, 8)}`;
    expect(findKeys(hex).map((k) => k.why)).toEqual(['maybe']);
  });

  it('a name already used gets a number', () => {
    expect(findKeys(RATEL, { names: ['RTL_API_KEY'] })[0]?.name).toBe('RTL_API_KEY_2');
  });

  it('not after you said that prefix isn’t a key', () => {
    expect(findKeys(RATEL, { notKeys: ['rtl_'] })).toEqual([]);
  });

  it.each([
    ['an Anthropic message id', `msg_${'013Zva2CMHLNnXjNJJKqJ2EF'}`],
    ['a tool use id', `toolu_${'01A09q90qw90lq917835lq9F'}`],
    ['a request id', `req_${'011CRaB2kd8Wq7Zx4vN9mP3t'}`],
    ['a Stripe payment', `pi_${'3MtwBwLkdIwHu7ix28a3tqPa'}`],
    ['a Stripe customer', `cus_${'NffrFeUfNV2Hib9Kq3Lm7Tx2'}`],
    ['a publishable key', `pk_live_${rand(40, undefined, 61)}`],
    ['a Clerk user', `user_${'2NNEqL2nrIRdJ194ndJqAHwEfxC'}`],
    ['a camelCase name', `get_${'UserProfileSettingsForAccount2'}`],
    ['words joined up', 'user_profile_settings_v2_migration_backfill'],
    ['inside a URL path', `https://example.com/download/rtl_${'k6RdVk9lLghguXqcpxATMBfV00FPbQPV'}`],
    ['a short body', 'rtl_k6RdVk9lLghg'],
    ['no prefix', rand(40, undefined, 71)],
  ])('%s is not', (_label, text) => {
    expect(findKeys(text)).toEqual([]);
  });

  it('looksLikeKey and keyShapes', () => {
    expect(looksLikeKey(`use ${RATEL}`)).toBe(true);
    expect(looksLikeKey('msg_013Zva2CMHLNnXjNJJKqJ2EF')).toBe(false);
    expect(keyShapes(`a ${RATEL}`)).toEqual([{ value: RATEL, prefix: 'rtl_', at: 2 }]);
  });

  it('suggestName', () => {
    expect(suggestName(RATEL)).toBe('RTL_API_KEY');
    expect(suggestName('hunter2hunter2')).toBe('SECRET');
    expect(suggestName('msg_013Zva2CMHLNnXjNJJKqJ2EF')).toBe('SECRET');
    expect(suggestName(RATEL, ['RTL_API_KEY', 'RTL_API_KEY_2'])).toBe('RTL_API_KEY_3');
  });
});

describe('findKeys: kept elsewhere in Beluga', () => {
  const elsewhere = [{ name: 'RATEL_API_KEY', value: `rtl_${rand(32, undefined, 41)}`, place: 'Ratel' }];

  it('shaped like a key another project keeps: its name, and where', () => {
    expect(findKeys(RATEL, { elsewhere })).toMatchObject([{ value: RATEL, name: 'RATEL_API_KEY', why: 'like-yours', from: 'RATEL_API_KEY', fromPlace: 'Ratel' }]);
  });

  it('the very key another project keeps: kept here too, under its name', () => {
    expect(findKeys(`use ${elsewhere[0]!.value}`, { elsewhere })).toMatchObject([{ name: 'RATEL_API_KEY', why: 'like-yours', fromPlace: 'Ratel' }]);
  });

  it('one here wins over one elsewhere', () => {
    const known = { RTL_KEY: elsewhere[0]!.value };
    expect(findKeys(elsewhere[0]!.value, { known, elsewhere })).toMatchObject([{ name: 'RTL_KEY', why: 'yours' }]);
  });
});
