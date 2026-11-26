import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PreviewManager } from '../src/preview/manager.js';
import { PreviewServer } from '../src/preview/server.js';
import { aliasesOf, findWrapper, isTailwindEntry, resolveImport, sourceLoader, stripJsonc } from '../src/preview/project.js';
import { componentsOf } from '../src/shared/preview/components.js';
import { providerNeeded, renderProblem } from '../src/shared/preview/opened.js';
import { parsePreviewRef } from '../src/shared/preview/ref.js';
import type { Field, Shape } from '../src/shared/preview/shape.js';

/**
 * Previews of real projects (BLG-826): types imported from other files, Vue and Svelte components,
 * Next.js's modules, the project's provider wrapper, Tailwind; and a missing provider said plainly.
 */

const brief = (s: Shape): string => (s.kind === 'union' ? s.of.map(brief).join('|') : s.kind === 'literal' ? JSON.stringify(s.value) : s.kind === 'array' ? `${brief(s.of)}[]` : s.kind === 'object' ? `{${s.fields.map((f) => f.name).join(',')}}` : s.kind);
const props = (fields: readonly Field[]): Record<string, string> => Object.fromEntries(fields.map((f) => [`${f.name}${f.optional ? '?' : ''}`, `${brief(f.shape)}${f.fallback !== undefined ? ` = ${JSON.stringify(f.fallback)}` : ''}`]));

const REACT = path.resolve('packages/mac/node_modules');
const haveReact = existsSync(path.join(REACT, 'react-dom'));

let root: string;
beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'beluga-projects-'));
  mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
  if (haveReact) symlinkSync(REACT, path.join(root, 'node_modules'));
  writeFileSync(path.join(root, 'tsconfig.json'), '{ // aliases\n "compilerOptions": { "baseUrl": ".", "paths": { "~/*": ["./src/*"], }, }, }\n');
  writeFileSync(path.join(root, 'src', 'lib', 'types.ts'), "export interface User { name: string; email: string }\nexport type Tone = 'sky' | 'rose';\n");
  writeFileSync(path.join(root, 'src', 'lib', 'index.ts'), "export * from './types';\n");
  writeFileSync(path.join(root, 'src', 'Card.tsx'), "import type { User } from './lib/types';\nimport { type Tone } from '~/lib';\nexport default function Card({ user, tone }: { user: User; tone: Tone }) { return <b className={tone}>{user.name}</b> }\n");
  writeFileSync(path.join(root, 'src', 'theme.tsx'), "import { createContext, useContext } from 'react';\nconst T = createContext<string | null>(null);\nexport const ThemeProvider = ({ children }: { children: React.ReactNode }) => <T.Provider value=\"#c4a7f5\">{children}</T.Provider>;\nexport function useTheme() { const t = useContext(T); if (!t) throw new Error('useTheme must be used within ThemeProvider'); return t; }\n");
  writeFileSync(path.join(root, 'src', 'Themed.tsx'), "import { useTheme } from './theme';\nexport default function Themed({ label }: { label: string }) { return <i style={{ color: useTheme() }}>{label}</i> }\n");
  writeFileSync(path.join(root, 'src', 'NextCard.tsx'), "import Image from 'next/image';\nimport Link from 'next/link';\nimport { Inter } from 'next/font/google';\nimport { useRouter } from 'next/navigation';\nconst inter = Inter({ subsets: ['latin'] });\nexport default function NextCard({ title }: { title: string }) { const r = useRouter(); return <div className={inter.className}><Image src=\"/a.png\" alt=\"\" width={4} height={4} /><Link href=\"/p\">{title}</Link><button onClick={() => r.push('/x')}>Go</button></div> }\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('types from the project’s other files', () => {
  it('follows relative imports, tsconfig aliases and re-exports, inside the worktree only', () => {
    expect(aliasesOf(root).map((a) => a.prefix)).toEqual(['~/']);
    expect(resolveImport(root, path.join(root, 'src', 'Card.tsx'), '~/lib')).toBe(realpathSync(path.join(root, 'src', 'lib', 'index.ts')));
    expect(resolveImport(root, path.join(root, 'src', 'Card.tsx'), '../../outside')).toBeUndefined();
    const card = componentsOf(path.join(root, 'src', 'Card.tsx'), "import type { User } from './lib/types';\nimport { type Tone } from '~/lib';\nexport default function Card({ user, tone }: { user: User; tone: Tone }) { return null }", sourceLoader(root, path.join(root, 'src', 'Card.tsx')));
    expect(props(card[0]!.props)).toEqual({ user: '{name,email}', tone: '"sky"|"rose"' });
  });

  it('reads a Next.js tsconfig (globs and aliases with stars, comments, trailing commas), extends, and .js imports', () => {
    expect(JSON.parse(stripJsonc('{ // c\n "compilerOptions": { /* x */ "paths": { "@/*": ["./*"], }, },\n "include": ["**/*.ts", "**/*.tsx"], }'))).toEqual({ compilerOptions: { paths: { '@/*': ['./*'] } }, include: ['**/*.ts', '**/*.tsx'] });
    const next = mkdtempSync(path.join(os.tmpdir(), 'beluga-next-'));
    try {
      mkdirSync(path.join(next, 'lib'));
      writeFileSync(path.join(next, 'tsconfig.base.json'), '{ "compilerOptions": { "paths": { "@/*": ["./*"] } } }');
      writeFileSync(path.join(next, 'tsconfig.json'), '{ "extends": "./tsconfig.base.json", "include": ["**/*.ts"] }');
      writeFileSync(path.join(next, 'lib', 'user.ts'), 'export interface User { name: string }');
      expect(aliasesOf(next).map((a) => a.prefix)).toEqual(['@/']);
      expect(resolveImport(next, path.join(next, 'page.tsx'), '@/lib/user')).toBe(realpathSync(path.join(next, 'lib', 'user.ts')));
      expect(resolveImport(next, path.join(next, 'page.tsx'), './lib/user.js')).toBe(realpathSync(path.join(next, 'lib', 'user.ts')));
    } finally {
      rmSync(next, { recursive: true, force: true });
    }
  });

  it('reads each file once however many types lead to it', () => {
    const load = sourceLoader(root, path.join(root, 'src', 'Card.tsx'));
    // The same answer, so the type reader's parse of it is kept too.
    expect(load('./lib/types')).toBeDefined();
    expect(load('./lib/types')).toBe(load('./lib/types'));
  });

  it('leaves them unknown without a way to read files (the window)', () => {
    const card = componentsOf('src/Card.tsx', "import type { User } from './lib/types';\nexport default function Card({ user }: { user: User }) { return null }");
    expect(props(card[0]!.props)).toEqual({ user: 'unknown' });
  });
});

describe('Vue and Svelte components', () => {
  it('reads Vue’s typed props, their defaults and its events', () => {
    const vue = `<script setup lang="ts">\nconst p = withDefaults(defineProps<{ title: string; size?: 'sm' | 'md' }>(), { size: 'md' });\nconst emit = defineEmits<{ select: [id: string] }>();\n</script><template><b>{{ title }}</b></template>`;
    const [c] = componentsOf('src/price-card.vue', vue);
    expect(c!.name).toBe('PriceCard');
    expect(props(c!.props)).toEqual({ title: 'string', 'size?': '"sm"|"md" = "md"', 'onSelect?': 'function' });
  });

  it('reads Vue’s runtime props, the Options API’s too', () => {
    expect(props(componentsOf('A.vue', '<script setup>defineProps({ title: String, count: { type: Number, default: 3 } })</script>')[0]!.props)).toEqual({ 'title?': 'string', 'count?': 'number = 3' });
    expect(props(componentsOf('B.vue', '<script>export default { props: { open: { type: Boolean, required: true } } }</script>')[0]!.props)).toEqual({ open: 'boolean' });
  });

  it('reads Svelte 5’s $props() and Svelte 4’s export let', () => {
    const five = `<script lang="ts">interface Props { label: string; tone?: 'mint' | 'peach' }\nlet { label, tone = 'mint' }: Props = $props();</script>`;
    expect(props(componentsOf('Badge.svelte', five)[0]!.props)).toEqual({ label: 'string', 'tone?': '"mint"|"peach" = "mint"' });
    expect(props(componentsOf('Old.svelte', '<script lang="ts">\nexport let name: string;\nexport let count: number = 2;\n</script>')[0]!.props)).toEqual({ name: 'string', 'count?': 'number = 2' });
  });
});

describe('the project’s setup', () => {
  it('finds the wrapper by name, or the one named in the block', () => {
    expect(findWrapper(root)).toBeUndefined();
    writeFileSync(path.join(root, 'preview-wrapper.tsx'), "import { ThemeProvider } from './src/theme';\nexport default function W({ children }: { children: React.ReactNode }) { return <ThemeProvider>{children}</ThemeProvider> }\n");
    expect(findWrapper(root)).toMatch(/preview-wrapper\.tsx$/);
    expect(findWrapper(root, '../elsewhere.tsx')).toBeUndefined();
    expect(parsePreviewRef('src/Card.tsx\nwrap: src/test/Providers.tsx')?.wrap).toBe('src/test/Providers.tsx');
  });

  it('knows a Tailwind stylesheet', () => {
    expect(isTailwindEntry('@import "tailwindcss";')).toBe(true);
    expect(isTailwindEntry("@tailwind base;\n@tailwind utilities;")).toBe(true);
    expect(isTailwindEntry('.card { color: red }')).toBe(false);
  });
});

describe('a missing provider, said plainly', () => {
  it('names the provider from what the component says', () => {
    expect(providerNeeded('useTheme must be used within ThemeProvider')).toBe('ThemeProvider');
    expect(providerNeeded('useNavigate() may be used only in the context of a <Router> component.')).toBe('Router');
    expect(providerNeeded('could not find react-redux context value; please ensure the component is wrapped in a <Provider>')).toBe('a Redux Provider');
    expect(providerNeeded('No QueryClient set, use QueryClientProvider to set one')).toBe('QueryClientProvider');
    expect(providerNeeded("Cannot read properties of undefined (reading 'map')")).toBeUndefined();
    const p = renderProblem('Themed', 'useTheme must be used within ThemeProvider', '');
    expect(p).toMatchObject({ kind: 'provider', title: 'Themed needs to sit inside ThemeProvider' });
    expect(p.forClaude).toContain('preview-wrapper.tsx');
  });
});

describe.skipIf(!haveReact)('built with the project', () => {
  const manager = new PreviewManager(new PreviewServer(0), { idleMs: 0 });
  afterAll(() => manager.close());
  const bundleOf = async (url: string): Promise<string> => (await fetch(`${url.split('?')[0]}bundle.js`)).text();

  it('draws a component inside the project’s wrapper', async () => {
    const out = await manager.open(root, { target: { kind: 'component', file: 'src/Themed.tsx' } });
    if (!out.ok) throw new Error(out.title);
    expect(out.component?.wrapper).toBe('preview-wrapper.tsx');
    expect(await bundleOf(out.url)).toContain('ThemeProvider');
  });

  it('gives each file its own next/font fonts', async () => {
    writeFileSync(path.join(root, 'src', 'fonts.ts'), "import { Geist } from 'next/font/google';\nexport const geist = Geist({ subsets: ['latin'] });\n");
    writeFileSync(path.join(root, 'src', 'TwoFonts.tsx'), "import { Inter } from 'next/font/google';\nimport { geist } from './fonts';\nconst inter = Inter({});\nexport default function TwoFonts() { return <b className={inter.className + geist.className}>x</b> }\n");
    const out = await manager.open(root, { target: { kind: 'component', file: 'src/TwoFonts.tsx' } });
    if (!out.ok) throw new Error(`${out.title}\n${out.forClaude}`);
  });

  it('builds a Next.js component without Next, its modules standing in', async () => {
    const out = await manager.open(root, { target: { kind: 'component', file: 'src/NextCard.tsx' } });
    if (!out.ok) throw new Error(`${out.title}\n${out.forClaude}`);
    const js = await bundleOf(out.url);
    expect(js).toContain('Inter');
    expect(js).toContain('navigate');
  });
});

/** Tailwind, Vue and Svelte builds need those packages: set BELUGA_PREVIEW_EXT to a folder that has them installed. */
const EXT = process.env.BELUGA_PREVIEW_EXT;
describe.skipIf(!EXT)('built with Tailwind, Vue and Svelte (BELUGA_PREVIEW_EXT)', () => {
  const manager = new PreviewManager(new PreviewServer(0), { idleMs: 0 });
  afterAll(() => manager.close());
  const files = async (url: string) => ({ js: await (await fetch(`${url.split('?')[0]}bundle.js`)).text(), css: await (await fetch(`${url.split('?')[0]}bundle.css`)).text() });

  it('styles Tailwind classes with the project’s own Tailwind', async () => {
    const out = await manager.open(EXT!, { target: { kind: 'component', file: 'src/Tw.tsx' } });
    if (!out.ok) throw new Error(`${out.title}\n${out.forClaude}`);
    const { css } = await files(out.url);
    expect(css).toMatch(/\.bg-sky-100\s*\{/);
    expect(css).toMatch(/hover\\:bg-violet-500/);
  });

  it('builds a Vue component with the project’s compiler', async () => {
    const out = await manager.open(EXT!, { target: { kind: 'component', file: 'src/Card.vue' } });
    if (!out.ok) throw new Error(`${out.title}\n${out.forClaude}`);
    expect(out.component?.framework).toBe('vue');
    expect((await files(out.url)).js).toContain('createApp');
  });

  it('builds a Svelte component with the project’s compiler', async () => {
    const out = await manager.open(EXT!, { target: { kind: 'component', file: 'src/Badge.svelte' } });
    if (!out.ok) throw new Error(`${out.title}\n${out.forClaude}`);
    expect(out.component?.framework).toBe('svelte');
    expect(out.props).toMatchObject({ label: expect.any(String) });
  });

  it('builds a SvelteKit component that uses $app and $lib (#641)', async () => {
    const out = await manager.open(EXT!, { target: { kind: 'component', file: 'src/KitNav.svelte' } });
    if (!out.ok) throw new Error(`${out.title}\n${out.forClaude}`);
    expect(out.component?.framework).toBe('svelte');
  });
});
