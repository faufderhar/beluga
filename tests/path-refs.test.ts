import { describe, expect, it } from 'vitest';
import { linkPaths, parsePathHref, pathHref, readPath, relativeCandidates, scratchCandidates } from '../src/shared/render/path-refs.js';
import { buildScratchAppend } from '../src/agent/prompt.js';

const link = (text: string, relative = true): string => linkPaths(text, { relative });

describe('readPath', () => {
  it('reads files and folders from a root, from home and relative to the worktree', () => {
    expect(readPath('/Users/me/Desktop/a.txt')).toEqual({ path: '/Users/me/Desktop/a.txt', dir: false, relative: false });
    expect(readPath('/tmp/')).toEqual({ path: '/tmp/', dir: true, relative: false });
    expect(readPath('~/notes/')).toEqual({ path: '~/notes/', dir: true, relative: false });
    expect(readPath('.beluga/scratch/01-login.png')).toEqual({ path: '.beluga/scratch/01-login.png', dir: false, relative: true });
    expect(readPath('.beluga/scratch/')).toEqual({ path: '.beluga/scratch/', dir: true, relative: true });
    expect(readPath('.beluga/scratch')).toEqual({ path: '.beluga/scratch', dir: false, relative: true });
    expect(readPath('src/agent/')).toEqual({ path: 'src/agent/', dir: true, relative: true });
    expect(readPath('./run.sh')).toEqual({ path: './run.sh', dir: false, relative: true });
    expect(readPath('../other/x')).toEqual({ path: '../other/x', dir: false, relative: true });
    expect(readPath('C:\\Users\\me\\a.txt')).toEqual({ path: 'C:\\Users\\me\\a.txt', dir: false, relative: false });
  });

  it('keeps the line a path points at', () => {
    expect(readPath('src/app.ts:12')).toEqual({ path: 'src/app.ts', line: 12, dir: false, relative: true });
    expect(readPath('src/app.ts:12:5')?.line).toBe(12);
    expect(readPath('src/app.ts#L40-L62')?.line).toBe(40);
  });

  it('takes spaces only when the whole text is the path, and only from a root or home', () => {
    expect(readPath('/Users/me/My Files/a.png')).toBeUndefined();
    expect(readPath('/Users/me/My Files/a.png', { spaces: true })?.path).toBe('/Users/me/My Files/a.png');
    expect(readPath("~/Kay's Notes/", { spaces: true })?.dir).toBe(true);
    expect(readPath('npm run dev/test.ts', { spaces: true })).toBeUndefined();
  });

  it('leaves alone what only looks a bit like a path', () => {
    for (const not of [
      'and/or', 'TCP/IP', 'w/o', 'N/A', '1/2', '3/4.5', '2026/11/07', 'e.g./i.e.',
      '/api/login', '/verify', '/', '~', 'README', 'package.json', 'console.log',
      'https://example.com/a/b.png', '//cdn.dev/x.js', 'example.com/a.png',
      '@beluga/shared/os-path.js', 'src/*.ts', 'src/{a,b}.ts', '$HOME/x.txt', 'a//b.ts', '-rf/x.ts',
    ]) {
      expect(readPath(not), not).toBeUndefined();
    }
  });
});

describe('path links', () => {
  it('round-trips a path through its link', () => {
    for (const ref of [readPath('src/a b.ts:3', { spaces: false }), readPath('.beluga/scratch/x.png:9'), readPath('~/n/'), readPath('/tmp/a#b.txt')]) {
      if (ref) expect(parsePathHref(pathHref(ref))).toEqual(ref);
    }
    expect(parsePathHref('https://x.dev')).toBeUndefined();
    expect(parsePathHref('beluga-path:%E0%A4%A')).toBeUndefined();
  });
});

describe('relativeCandidates', () => {
  it('looks in the worktree first, then in its .beluga folder (a path written from there)', () => {
    expect(relativeCandidates('scratch/pr-498/')).toEqual(['scratch/pr-498', '.beluga/scratch/pr-498']);
    expect(relativeCandidates('./reports/a.md')).toEqual(['reports/a.md', '.beluga/reports/a.md']);
  });

  it('looks once for a path already under .beluga, or one climbing out of the worktree', () => {
    expect(relativeCandidates('.beluga/scratch/x.png')).toEqual(['.beluga/scratch/x.png']);
    expect(relativeCandidates('../other/a.ts')).toEqual(['../other/a.ts']);
    expect(relativeCandidates('src/app.ts')).toEqual(['src/app.ts', '.beluga/src/app.ts']);
  });
});

describe('scratchCandidates', () => {
  it('looks in each checkout an agent made in the scratch folder (a path written from there)', () => {
    expect(scratchCandidates('packages/mac/src/chat/starting-model.ts', ['land-492', 'land-494'])).toEqual([
      '.beluga/scratch/land-492/packages/mac/src/chat/starting-model.ts',
      '.beluga/scratch/land-494/packages/mac/src/chat/starting-model.ts',
    ]);
    expect(scratchCandidates('./src/app.ts/', ['pr-12'])).toEqual(['.beluga/scratch/pr-12/src/app.ts']);
  });

  it('looks nowhere else for a path already under .beluga, one climbing out, or with no folders', () => {
    expect(scratchCandidates('.beluga/scratch/x.png', ['pr-12'])).toEqual([]);
    expect(scratchCandidates('../other/a.ts', ['pr-12'])).toEqual([]);
    expect(scratchCandidates('src/app.ts', [])).toEqual([]);
  });

  it('skips folders that are not a plain name, and the folders Beluga keeps there itself', () => {
    expect(scratchCandidates('a.ts', ['..', '.git', 'sent', 'agents', 'x/y', 'ok'])).toEqual(['.beluga/scratch/ok/a.ts']);
  });
});

describe('linkPaths', () => {
  it('links paths in words, keeping the punctuation after them', () => {
    expect(link('Saved to .beluga/scratch/01-login.png.')).toBe('Saved to [.beluga/scratch/01-login.png](beluga-path:.beluga%2Fscratch%2F01-login.png).');
    expect(link('See src/app.ts:12, then ~/notes/')).toBe('See [src/app.ts:12](beluga-path:src%2Fapp.ts#12), then [~/notes/](beluga-path:~%2Fnotes%2F)');
    expect(link('- **src/a.ts**: changed')).toBe('- **[src/a.ts](beluga-path:src%2Fa.ts)**: changed');
  });

  it('makes a path in backticks the link, code and all', () => {
    expect(link('Open `.beluga/scratch/`')).toBe('Open [`.beluga/scratch/`](beluga-path:.beluga%2Fscratch%2F)');
    expect(link('It is in `/Users/me/My Files/a.png` now')).toBe('It is in [`/Users/me/My Files/a.png`](beluga-path:%2FUsers%2Fme%2FMy%20Files%2Fa.png) now');
    expect(link('Run `npm test` in src/web/')).toBe('Run `npm test` in [src/web/](beluga-path:src%2Fweb%2F)');
  });

  it('leaves code blocks, links and web addresses alone', () => {
    const fenced = '```\nsrc/a.ts\n```';
    expect(link(fenced)).toBe(fenced);
    const nested = '````md\n```\nsrc/a.ts\n```\n````';
    expect(link(nested)).toBe(nested);
    expect(link('[the file](src/a.ts) and src/b.ts')).toBe('[the file](src/a.ts) and [src/b.ts](beluga-path:src%2Fb.ts)');
    expect(link('[`src/a.ts`](https://github.com/x/y/blob/main/src/a.ts)')).toBe('[`src/a.ts`](https://github.com/x/y/blob/main/src/a.ts)');
    expect(link('at https://github.com/x/y/blob/main/src/a.ts')).toBe('at https://github.com/x/y/blob/main/src/a.ts');
    expect(link('![shot](/tmp/a.png)')).toBe('![shot](/tmp/a.png)');
    expect(link('POST /api/login and/or GET /verify')).toBe('POST /api/login and/or GET /verify');
  });

  it('links relative paths only where there is a worktree to open them in', () => {
    expect(link('see src/a.ts and /tmp/x.log', false)).toBe('see src/a.ts and [/tmp/x.log](beluga-path:%2Ftmp%2Fx.log)');
    expect(link('`src/a.ts`', false)).toBe('`src/a.ts`');
  });
});

describe('the scratch prompt', () => {
  it('asks for a file in a checkout made in scratch to be named with that folder in front, so its link opens', () => {
    const text = buildScratchAppend('.beluga/scratch');
    expect(text).toContain('whole path from your working folder');
    expect(text).toContain('.beluga/scratch/land-12/src/app.ts, not src/app.ts');
  });
});
