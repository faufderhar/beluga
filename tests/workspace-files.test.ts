import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileEditError,
  MAX_LINES,
  PREVIEW_CHARS,
  byteToChar,
  findPrettier,
  findRipgrep,
  formatWithPrettier,
  formatterFor,
  hashText,
  matchLines,
  ownPrettier,
  parseRgLine,
  previewLine,
  queryRegex,
  resolveInWorkspace,
  ripgrepArgs,
  searchContents,
  searchNames,
  writeWorkspaceFile,
} from '../src/core/workspace-files.js';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-wsfiles-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (rel: string, text: string): void => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
};

const rgMatch = (p: string, line: string, n: number, subs: Array<[number, number]>): string =>
  JSON.stringify({ type: 'match', data: { path: { text: p }, lines: { text: line }, line_number: n, absolute_offset: 0, submatches: subs.map(([start, end]) => ({ match: { text: '' }, start, end })) } });

describe('ripgrep output', () => {
  it('reads a match: path without ./, line, trimmed preview, ranges', () => {
    const hit = parseRgLine(
      rgMatch('./src/a.ts', '    const auth = makeAuth();\n', 12, [
        [10, 14],
        [21, 25],
      ]),
    );
    expect(hit).toEqual({
      path: 'src/a.ts',
      match: {
        line: 12,
        text: 'const auth = makeAuth();',
        ranges: [
          [6, 10],
          [17, 21],
        ],
      },
    });
  });

  it('turns byte offsets into character offsets on non-ASCII lines', () => {
    const line = 'é→ auth\n';
    // "é" is 2 bytes and "→" 3: "auth" starts at byte 6, character 3.
    expect(byteToChar(line, 6)).toBe(3);
    const hit = parseRgLine(rgMatch('x.md', line, 1, [[6, 10]]));
    expect(hit?.match.text.slice(...(hit.match.ranges[0] as [number, number]))).toBe('auth');
  });

  it('reads paths and lines ripgrep sends as bytes (not valid UTF-8 names)', () => {
    const ev = { type: 'match', data: { path: { bytes: Buffer.from('odd.txt').toString('base64') }, lines: { bytes: Buffer.from('find me\n').toString('base64') }, line_number: 3, submatches: [{ start: 0, end: 4 }] } };
    expect(parseRgLine(JSON.stringify(ev))).toEqual({ path: 'odd.txt', match: { line: 3, text: 'find me', ranges: [[0, 4]] } });
  });

  it('skips begin, end, summary and garbage', () => {
    expect(parseRgLine(JSON.stringify({ type: 'begin', data: { path: { text: 'a' } } }))).toBeUndefined();
    expect(parseRgLine(JSON.stringify({ type: 'summary', data: {} }))).toBeUndefined();
    expect(parseRgLine('not json')).toBeUndefined();
    expect(parseRgLine('')).toBeUndefined();
  });

  it('asks for plain text unless regex, the case you chose, and never .git', () => {
    const plain = ripgrepArgs('a.b', {});
    expect(plain).toContain('--fixed-strings');
    expect(plain).toContain('--ignore-case');
    expect(plain.slice(-3)).toEqual(['a.b', '--', '.']);
    expect(plain.join(' ')).toContain('--glob !.git');
    const re = ripgrepArgs('a.b', { regex: true, caseSensitive: true, wholeWord: true });
    expect(re).not.toContain('--fixed-strings');
    expect(re).toContain('--case-sensitive');
    expect(re).toContain('--word-regexp');
    // A query that looks like a flag is still the pattern.
    expect(ripgrepArgs('--files', {})).toContain('--regexp');
  });
});

describe('previews', () => {
  it('clips a long line around the first match and keeps its range on the match', () => {
    const line = `${'x'.repeat(500)}NEEDLE${'y'.repeat(500)}`;
    const { text, ranges } = previewLine(line, [[500, 506]]);
    expect(text.length).toBeLessThanOrEqual(PREVIEW_CHARS + 2);
    expect(text.startsWith('…') && text.endsWith('…')).toBe(true);
    expect(text.slice(...(ranges[0] as [number, number]))).toBe('NEEDLE');
  });

  it('drops ranges that fall outside what is shown', () => {
    const line = `a${' '.repeat(10)}${'z'.repeat(400)}a`;
    const { ranges } = previewLine(line, [
      [0, 1],
      [411, 412],
    ]);
    expect(ranges).toEqual([[0, 1]]);
  });

  it('finds every match on each line in the Node search', () => {
    const lines = matchLines('foo bar foo\nnone\n  FOO\n', queryRegex('foo', {}));
    expect(lines).toEqual([
      {
        line: 1,
        text: 'foo bar foo',
        ranges: [
          [0, 3],
          [8, 11],
        ],
      },
      { line: 3, text: 'FOO', ranges: [[0, 3]] },
    ]);
    expect(matchLines('foo FOO', queryRegex('foo', { caseSensitive: true }))).toHaveLength(1);
    expect(matchLines('food foo', queryRegex('foo', { wholeWord: true }))[0]?.ranges).toEqual([[5, 8]]);
    expect(matchLines('a.b axb', queryRegex('a.b', {}))[0]?.ranges).toEqual([[0, 3]]);
    expect(matchLines('a.b axb', queryRegex('a.b', { regex: true }))[0]?.ranges).toEqual([
      [0, 3],
      [4, 7],
    ]);
  });
});

describe('searching a workspace', () => {
  beforeEach(() => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    put('.gitignore', 'ignored/\n*.log\n');
    put('src/auth.ts', 'export function login() {\n  return checkToken();\n}\n');
    put('src/other.ts', 'const token = 1;\n');
    put('ignored/secret.ts', 'checkToken();\n');
    put('debug.log', 'checkToken\n');
    put('bin.dat', 'checkToken\0\0\0');
  });

  for (const engine of ['node', 'auto'] as const) {
    describe(engine === 'node' ? 'in Node' : 'with ripgrep (when it is here)', () => {
      it('finds lines by file, skipping ignored and binary files', async () => {
        if (engine === 'auto' && !findRipgrep()) return;
        const res = await searchContents(dir, 'checktoken', {}, undefined, engine);
        expect(res.engine).toBe(engine === 'node' ? 'node' : 'ripgrep');
        expect(res.files).toEqual([{ path: 'src/auth.ts', matches: [{ line: 2, text: 'return checkToken();', ranges: [[7, 17]] }] }]);
        expect(res.count).toBe(1);
        expect(res.truncated).toBe(false);
      });

      it('says when a pattern is broken', async () => {
        if (engine === 'auto' && !findRipgrep()) return;
        const res = await searchContents(dir, '(unclosed', { regex: true }, undefined, engine);
        expect(res.error).toMatch(/pattern/i);
        expect(res.files).toEqual([]);
      });

      it('stops at the cap', async () => {
        if (engine === 'auto' && !findRipgrep()) return;
        for (let i = 0; i < 30; i++) put(`many/f${i}.txt`, 'hit\n'.repeat(45));
        const res = await searchContents(dir, 'hit', {}, undefined, engine);
        expect(res.count).toBe(MAX_LINES);
        expect(res.truncated).toBe(true);
      });

      it('gives up when cancelled', async () => {
        if (engine === 'auto' && !findRipgrep()) return;
        const ctl = new AbortController();
        ctl.abort();
        const res = await searchContents(dir, 'token', {}, ctl.signal, engine);
        expect(res.cancelled).toBe(true);
      });
    });
  }

  it('walks the folder (skipping node_modules) outside a git repository', async () => {
    rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    put('node_modules/pkg/index.js', 'checkToken\n');
    const res = await searchContents(dir, 'checkToken(', {}, undefined, 'node');
    expect(res.files.map((f) => f.path).sort()).toEqual(['ignored/secret.ts', 'src/auth.ts']);
  });
});

describe('searching names', () => {
  beforeEach(() => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    put('.gitignore', 'dist/\n');
    put('src/auth/login.ts', '');
    put('src/auth/login.test.ts', '');
    put('src/server.ts', '');
    put('README.md', '');
    put('dist/login.js', '');
  });

  for (const engine of ['node', 'auto'] as const) {
    it(`finds files anywhere by their path, skipping what git ignores (${engine})`, async () => {
      if (engine === 'auto' && !findRipgrep()) return;
      const res = await searchNames(dir, 'login', {}, undefined, engine);
      expect(res.files.map((f) => f.path)).toEqual(['src/auth/login.test.ts', 'src/auth/login.ts']);
      expect(res.files[1]!.ranges).toEqual([[9, 14]]);
    });
  }

  it('takes a regular expression over the whole path, and says when one doesn’t parse', async () => {
    expect((await searchNames(dir, '^src/.*\\.test\\.ts$', { regex: true }, undefined, 'node')).files.map((f) => f.path)).toEqual(['src/auth/login.test.ts']);
    expect((await searchNames(dir, 'readme', { caseSensitive: true }, undefined, 'node')).files).toEqual([]);
    expect((await searchNames(dir, 'README', { caseSensitive: true }, undefined, 'node')).files.map((f) => f.path)).toEqual(['README.md']);
    expect((await searchNames(dir, '(unclosed', { regex: true }, undefined, 'node')).error).toMatch(/Not a valid pattern/);
  });
});

describe('where an edit may go', () => {
  beforeEach(() => put('src/a.ts', 'a\n'));

  it('resolves a file inside, and a new one in a folder inside', () => {
    expect(resolveInWorkspace(dir, 'src/a.ts')).toBe(path.join(dir, 'src/a.ts'));
    expect(resolveInWorkspace(dir, './src//b.ts')).toBe(path.join(dir, 'src/b.ts'));
    expect(resolveInWorkspace(dir, 'new/deep/c.ts')).toBe(path.join(dir, 'new/deep/c.ts'));
  });

  it('refuses .., absolute paths, .git and empty paths', () => {
    for (const bad of ['../x', 'src/../../x', '/etc/hosts', '.git/config', '', 'a\0b', 'src\\..\\..\\x']) {
      expect(() => resolveInWorkspace(dir, bad), bad).toThrow(FileEditError);
    }
  });

  it('refuses symlinks that lead out, to a file or through a folder', () => {
    const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-outside-')));
    try {
      writeFileSync(path.join(outside, 'x.txt'), 'x');
      symlinkSync(path.join(outside, 'x.txt'), path.join(dir, 'link.txt'));
      symlinkSync(outside, path.join(dir, 'out'));
      expect(() => resolveInWorkspace(dir, 'link.txt')).toThrow(/outside/);
      expect(() => resolveInWorkspace(dir, 'out/x.txt')).toThrow(/outside/);
      expect(() => resolveInWorkspace(dir, 'out/new.txt')).toThrow(/outside/);
      // A link that stays inside is fine (it resolves to the real file).
      symlinkSync(path.join(dir, 'src/a.ts'), path.join(dir, 'inside.ts'));
      expect(resolveInWorkspace(dir, 'inside.ts')).toBe(path.join(dir, 'src/a.ts'));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('saving', () => {
  beforeEach(() => put('src/a.ts', 'one\n'));

  it('writes the file, keeping its mode, when it has not changed since', async () => {
    chmodSync(path.join(dir, 'src/a.ts'), 0o755);
    const res = await writeWorkspaceFile(dir, 'src/a.ts', 'two\n', { expect: hashText('one\n') });
    expect(res).toEqual({ ok: true, hash: hashText('two\n') });
    expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toBe('two\n');
    // Windows keeps no executable bit.
    if (process.platform !== 'win32') expect(statSync(path.join(dir, 'src/a.ts')).mode & 0o777).toBe(0o755);
  });

  it('asks first when the file changed since you started, and saves when forced', async () => {
    put('src/a.ts', 'changed by Claude\n');
    expect(await writeWorkspaceFile(dir, 'src/a.ts', 'mine\n', { expect: hashText('one\n') })).toEqual({ ok: false, conflict: true });
    expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toBe('changed by Claude\n');
    expect((await writeWorkspaceFile(dir, 'src/a.ts', 'mine\n', { expect: hashText('one\n'), force: true })).ok).toBe(true);
    expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toBe('mine\n');
  });

  it('refuses paths outside, missing files, folders and files that are not UTF-8 text', async () => {
    await expect(writeWorkspaceFile(dir, '../evil.ts', 'x')).rejects.toThrow(FileEditError);
    await expect(writeWorkspaceFile(dir, 'nope.ts', 'x')).rejects.toThrow(/isn’t there/);
    await expect(writeWorkspaceFile(dir, 'src', 'x')).rejects.toThrow(/Only files/);
    writeFileSync(path.join(dir, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    await expect(writeWorkspaceFile(dir, 'latin1.txt', 'x')).rejects.toThrow(/UTF-8/);
  });
});

describe('Prettier', () => {
  /** A stand-in for Prettier: upper-cases what it's given, fails on "bad", knows no .rs. */
  const fakePrettier = (at: string): void => {
    put(`${at}node_modules/prettier/package.json`, JSON.stringify({ name: 'prettier', version: '9.9.9', bin: { prettier: 'bin/prettier.cjs' } }));
    put(
      `${at}node_modules/prettier/bin/prettier.cjs`,
      `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const f=process.argv[process.argv.indexOf('--stdin-filepath')+1];` +
        `if(f.endsWith('.rs')){console.error('[error] No parser could be inferred for file "'+f+'".');process.exit(2)}` +
        `if(s.includes('bad')){console.error('[error] x.ts: SyntaxError: Unexpected token (1:1)');process.exit(2)}process.stdout.write(s.toUpperCase())});`,
    );
  };

  it('uses the Prettier Beluga ships when the project has none', async () => {
    put('a.ts', 'x');
    const own = ownPrettier();
    expect(own?.version).toMatch(/^3\./);
    expect(findPrettier(path.join(dir, 'a.ts'), dir)).toBeUndefined();
    expect(formatterFor(dir, 'a.ts')).toEqual({ available: true, version: own?.version, bundled: true });
    expect(formatterFor(dir, 'main.rs')).toMatchObject({ available: false, bundled: true, reason: expect.stringMatching(/doesn’t format/) });
    expect(await formatWithPrettier(dir, 'a.ts', 'const a={b:1}')).toBe('const a = { b: 1 };\n');
    // The project's config still applies.
    put('.prettierrc', JSON.stringify({ semi: false, singleQuote: true }));
    expect(await formatWithPrettier(dir, 'a.ts', 'const a = "x";')).toBe("const a = 'x'\n");
  });

  it('finds the nearest one, or the main folder’s, and formats with it', async () => {
    const main = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-main-')));
    try {
      put('pkg/a.ts', 'x');
      writeFileSync(path.join(main, 'keep'), '');
      expect(findPrettier(path.join(dir, 'pkg/a.ts'), dir)).toBeUndefined();
      fakePrettier('');
      expect(findPrettier(path.join(dir, 'pkg/a.ts'), dir)?.version).toBe('9.9.9');
      expect(formatterFor(dir, 'pkg/a.ts')).toEqual({ available: true, version: '9.9.9' });
      expect(formatterFor(dir, 'main.rs')).toMatchObject({ available: false, reason: expect.stringMatching(/doesn’t format/) });
      expect(await formatWithPrettier(dir, 'pkg/a.ts', 'const a = 1\n')).toBe('CONST A = 1\n');
      await expect(formatWithPrettier(dir, 'pkg/a.ts', 'bad')).rejects.toThrow(/Syntax error/);
      // Only in the project's main folder (a worktree without its own node_modules).
      rmSync(path.join(dir, 'node_modules'), { recursive: true });
      expect(findPrettier(path.join(dir, 'pkg/a.ts'), dir, [main])).toBeUndefined();
      const keep = dir;
      dir = main;
      fakePrettier('');
      dir = keep;
      expect(findPrettier(path.join(dir, 'pkg/a.ts'), dir, [main])?.bin).toBe(path.join(main, 'node_modules/prettier/bin/prettier.cjs'));
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });

  it('says which kinds of file it can’t format', async () => {
    fakePrettier('');
    put('main.rs', 'fn main() {}');
    await expect(formatWithPrettier(dir, 'main.rs', 'fn main() {}')).rejects.toThrow(/doesn’t format this kind/);
  });
});
