/**
 * Which command a shell line is about, for a Bash span's name and attributes ("Bash:git", subcommand
 * "commit"). Worked out on this computer from the command's text; only program names and the
 * subcommands of a few known tools come out, never arguments, paths or values.
 *
 * The rule: split on `&&`, `||`, `;` and new lines; drop setup segments (cd, export, source, bare
 * VAR= assignments); a pipeline is its first command; wrappers (timeout, env, xargs, npx, bunx,
 * uv run, sudo…) are unwrapped; the last meaningful segment names the line.
 */

export interface CommandFacts {
  /** The program the line is about: "git", "npm", "vitest". "other" when it isn't a plain name. */
  readonly command: string;
  /** Its subcommand, for tools that have them: "commit", "pr create", "run build". */
  readonly subcommand?: string;
  /** Every command of the line, in order (each pipeline stage of each segment), at most MAX_COMMANDS. */
  readonly commands: readonly string[];
  /** How many segments the line has (split on `&&`, `||`, `;` and new lines). */
  readonly segments: number;
  /** What the line did that matters afterwards, each once: a commit, a pull request opened, a test run. */
  readonly effects?: readonly CommandEffect[];
}

export type CommandEffect = 'commit' | 'pr_open' | 'test';

/** A line longer than this is cut before it is read. */
const MAX_LINE = 20_000;
const MAX_COMMANDS = 20;

/** Segments that only prepare the shell. */
const SETUP = new Set(['cd', 'pushd', 'popd', 'export', 'source', '.', 'set', 'unset']);
/** Commands that say little about what a line did, when another command is there. */
const TRIVIAL = new Set(['echo', 'printf', 'true', 'false', ':', 'sleep', 'wait']);
/** Programs that run another program: the flags of each that take a value. */
const WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  env: new Set(['-u', '--unset', '-C', '--chdir']),
  xargs: new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a']),
  npx: new Set(['-p', '--package', '-c', '--call']),
  bunx: new Set(['-p', '--package']),
  sudo: new Set(['-u', '-g', '-C', '-p']),
  nice: new Set(['-n']),
  nohup: new Set(),
  time: new Set(),
  command: new Set(),
  exec: new Set(),
};
/** `uv run`'s flags that take a value. */
const UV_RUN = new Set(['--with', '--with-requirements', '--python', '-p', '--project', '--directory', '--env-file', '--group', '--extra']);
/** Tools whose first word after the name says what they do: the flags of each that take a value. */
const SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  git: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']),
  gh: new Set(['-R', '--repo']),
  npm: new Set(['--prefix', '-w', '--workspace', '-C']),
  pnpm: new Set(['--filter', '-F', '-C', '--dir']),
  yarn: new Set(['--cwd']),
  bun: new Set(['--cwd']),
  docker: new Set(['-H', '--host', '--context', '-c', '--config']),
  kubectl: new Set(['-n', '--namespace', '--context', '--kubeconfig']),
  cargo: new Set(['--manifest-path']),
  go: new Set(),
  brew: new Set(),
  pip: new Set(),
  pip3: new Set(),
  uv: new Set(),
  make: new Set(['-C', '-f', '-j']),
  terraform: new Set(['-chdir']),
  helm: new Set(['-n', '--namespace', '--kube-context']),
};
/** Subcommands that are a group: the word after them is kept too ("pr create", "run build", "compose up"). */
const GROUPS: Readonly<Record<string, ReadonlySet<string>>> = {
  gh: new Set(['pr', 'issue', 'repo', 'run', 'workflow', 'release', 'gist', 'secret', 'variable', 'label', 'project', 'cache', 'auth', 'extension', 'search', 'ruleset']),
  npm: new Set(['run', 'run-script']),
  pnpm: new Set(['run']),
  yarn: new Set(['run']),
  bun: new Set(['run']),
  docker: new Set(['compose', 'buildx', 'image', 'container', 'volume', 'network', 'system']),
};

/** Programs that run tests whatever comes after them. */
const TEST_RUNNERS = new Set(['vitest', 'jest', 'pytest', 'playwright', 'mocha', 'rspec', 'phpunit', 'ava', 'tox', 'nox']);
/** Tools whose `test` subcommand runs tests (`npm test`, `npm run test:unit`, `cargo test`, `make test`). */
const TEST_TOOLS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'make', 'deno', 'dotnet', 'gradle', 'mvn']);
const TEST_SUBCOMMAND = /^(?:run(?:-script)? )?test(?:[:._-][\w:.-]*)?$/;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PROGRAM = /^[A-Za-z0-9_][A-Za-z0-9_.+@-]{0,39}$/;
const SUBCOMMAND = /^[A-Za-z][A-Za-z0-9:_.-]{0,23}$/;

export function commandFacts(line: string): CommandFacts | undefined {
  const all = segmentsOf(line.slice(0, MAX_LINE)).map((stages) => stages.map(commandOf).filter((c): c is Named => c !== undefined));
  const segments = all.filter((s) => s.length);
  if (!segments.length) return undefined;
  const firsts = segments.map((s) => s[0]!);
  const primary = lastWhere(firsts, (c) => !SETUP.has(c.name) && !TRIVIAL.has(c.name)) ?? lastWhere(firsts, (c) => !SETUP.has(c.name)) ?? firsts.at(-1)!;
  const effects = EFFECTS.filter((e) => segments.some((s) => effectOf(s[0]!) === e));
  return {
    command: primary.name,
    ...(primary.subcommand ? { subcommand: primary.subcommand } : {}),
    commands: segments.flatMap((s) => s.map((c) => c.name)).slice(0, MAX_COMMANDS),
    segments: segments.length,
    ...(effects.length ? { effects } : {}),
  };
}

interface Named {
  readonly name: string;
  readonly subcommand?: string;
}

const EFFECTS: readonly CommandEffect[] = ['commit', 'pr_open', 'test'];

/** What a segment's command did that matters afterwards, from its name and subcommand alone. */
function effectOf(c: Named): CommandEffect | undefined {
  if (c.name === 'git' && c.subcommand === 'commit') return 'commit';
  if (c.name === 'gh' && c.subcommand === 'pr create') return 'pr_open';
  if (TEST_RUNNERS.has(c.name) || (TEST_TOOLS.has(c.name) && TEST_SUBCOMMAND.test(c.subcommand ?? ''))) return 'test';
  return undefined;
}

const lastWhere = <T>(list: readonly T[], test: (v: T) => boolean): T | undefined => [...list].reverse().find(test);

/** One pipeline stage's words as the program it runs: assignments and wrappers taken off. Nothing: only assignments. */
function commandOf(words: readonly string[]): Named | undefined {
  let rest: readonly string[] = words.filter((w) => w !== '{' && w !== '}' && w !== '!');
  for (;;) {
    while (rest[0] !== undefined && ASSIGNMENT.test(rest[0])) rest = rest.slice(1);
    const head = rest[0];
    if (head === undefined) return undefined;
    const name = programOf(head);
    const inner = name === 'uv' && rest[1] === 'run' ? afterFlags(rest.slice(2), UV_RUN) : WRAPPERS[name] ? afterFlags(rest.slice(1), WRAPPERS[name]!) : undefined;
    // `timeout 30 npm test`: its duration comes before the command.
    const unwrapped = inner && name === 'timeout' ? inner.slice(1) : inner;
    if (!unwrapped?.length) return { name, ...subcommandOf(name, rest.slice(1)) };
    rest = unwrapped;
  }
}

/** A word as a program's name: without its folder; "other" when it isn't a plain name (a variable, a masked value). */
function programOf(word: string): string {
  const base = word.split('/').at(-1) ?? '';
  return PROGRAM.test(base) || SETUP.has(base) || TRIVIAL.has(base) ? base : 'other';
}

/** The words after a program's own flags (those in `valued` take the next word with them). */
function afterFlags(words: readonly string[], valued: ReadonlySet<string>): readonly string[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (w === '--') return words.slice(i + 1);
    if (ASSIGNMENT.test(w)) i++;
    else if (!w.startsWith('-')) break;
    else i += valued.has(w) ? 2 : 1;
  }
  return words.slice(i);
}

function subcommandOf(name: string, args: readonly string[]): { subcommand?: string } {
  const valued = SUBCOMMANDS[name];
  if (!valued) return {};
  const [first, ...more] = afterFlags(args, valued);
  if (!first || !SUBCOMMAND.test(first)) return {};
  const second = GROUPS[name]?.has(first) ? afterFlags(more, new Set())[0] : undefined;
  return { subcommand: second && SUBCOMMAND.test(second) ? `${first} ${second}` : first };
}

/**
 * A line as its segments, each a pipeline of stages, each a list of words. Quotes, `$(…)`, backticks
 * and here-documents are never split: what is in them is one word's text (or dropped).
 */
function segmentsOf(line: string): string[][][] {
  const segments: string[][][] = [];
  let stages: string[][] = [];
  let words: string[] = [];
  let word = '';
  let quote = '';
  let depth = 0;
  const heredocs: string[] = [];
  const endWord = (): void => {
    if (word) words.push(word);
    word = '';
  };
  const endStage = (): void => {
    endWord();
    if (words.length) stages.push(words);
    words = [];
  };
  const endSegment = (): void => {
    endStage();
    if (stages.length) segments.push(stages);
    stages = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    const next = line[i + 1];
    if (c === '\\' && quote !== "'") {
      // A backslash before a new line continues the line; before anything else it keeps that character.
      if (next !== '\n') word += next ?? '';
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
      else word += c;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (depth > 0) {
      if (c === '(') depth++;
      else if (c === ')') depth--;
      word += c;
      continue;
    }
    if (c === '$' && next === '(') {
      depth = 1;
      word += '$(';
      i++;
      continue;
    }
    if (c === '<' && next === '<' && line[i + 2] !== '<') {
      const m = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line.slice(i));
      if (m) {
        heredocs.push(m[2]!);
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === '\n') {
      endSegment();
      // A here-document's body: skipped up to its end word.
      while (heredocs.length) {
        const end = heredocs.shift()!;
        let at = i + 1;
        for (;;) {
          const stop = line.indexOf('\n', at);
          const text = line.slice(at, stop < 0 ? line.length : stop);
          at = stop < 0 ? line.length : stop + 1;
          if (text.trim() === end || stop < 0) break;
        }
        i = at - 1;
      }
      continue;
    }
    if (c === ';' || (c === '&' && next === '&') || (c === '|' && next === '|')) {
      endSegment();
      if (c !== ';') i++;
      continue;
    }
    if (c === '|') {
      endStage();
      if (next === '&') i++;
      continue;
    }
    // A lone `&` puts a command in the background; beside `>` it is a redirection (2>&1, &>).
    if (c === '&' && next !== '>' && line[i - 1] !== '>') {
      endSegment();
      continue;
    }
    if (c === '(' || c === ')') {
      endWord();
      continue;
    }
    // A comment runs to the end of its line.
    if (c === '#' && !word) {
      const stop = line.indexOf('\n', i);
      i = (stop < 0 ? line.length : stop) - 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      continue;
    }
    word += c;
  }
  endSegment();
  return segments;
}
