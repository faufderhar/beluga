import { describe, expect, it } from 'vitest';
import { commandFacts } from '../src/telemetry/command.js';

/** The command-family rule (AOBS-4): which command a shell line is about, worked out on this computer. */
describe('the command a shell line is about', () => {
  const primary = (line: string): string | undefined => {
    const f = commandFacts(line);
    return f ? [f.command, f.subcommand].filter(Boolean).join(' ') : undefined;
  };

  it('a plain command is itself, with its subcommand where the tool has them', () => {
    expect(primary('ls -la')).toBe('ls');
    expect(primary('git status --short')).toBe('git status');
    expect(primary('git -C /repo -c core.pager=cat log --oneline')).toBe('git log');
    expect(primary('gh pr create --draft --title "x"')).toBe('gh pr create');
    expect(primary('npm run typecheck')).toBe('npm run typecheck');
    expect(primary('docker compose up -d')).toBe('docker compose up');
    expect(primary('kubectl get pods -n prod')).toBe('kubectl get');
    expect(primary('npx vitest run tests/a.test.ts')).toBe('vitest');
  });

  it('a path to a program is the program', () => {
    expect(primary('./node_modules/.bin/tsc --noEmit')).toBe('tsc');
    expect(primary('/usr/bin/env node script.js')).toBe('node');
  });

  it('setup segments are dropped: cd, export, source, and VAR= prefixes', () => {
    expect(primary('cd /repo && git commit -m "fix"')).toBe('git commit');
    expect(primary('export FOO=1; source .venv/bin/activate; pytest -q')).toBe('pytest');
    expect(primary('FOO=1 BAR="two words" node build.js')).toBe('node');
    expect(primary('CI=1')).toBeUndefined();
  });

  it('a pipeline is its first command; what follows a pipe is a filter', () => {
    expect(primary('git log --oneline | head -5')).toBe('git log');
    expect(primary('cat a.json | jq .name | wc -l')).toBe('cat');
    expect(commandFacts('git log | grep fix | wc -l')?.commands).toEqual(['git', 'grep', 'wc']);
  });

  it('wrappers are unwrapped: timeout, env, xargs, npx, bunx, uv run, sudo', () => {
    expect(primary('timeout 30 npm test')).toBe('npm test');
    expect(primary('timeout -s KILL 5m curl https://example.com')).toBe('curl');
    expect(primary('env NODE_ENV=test node x.js')).toBe('node');
    expect(primary('find . -name "*.ts" | xargs -n 10 grep TODO')).toBe('find');
    expect(primary('xargs -I {} rm {}')).toBe('rm');
    expect(primary('npx --yes prettier --check .')).toBe('prettier');
    expect(primary('bunx tsc')).toBe('tsc');
    expect(primary('uv run --with rich pytest')).toBe('pytest');
    expect(primary('sudo -n systemctl restart x')).toBe('systemctl');
  });

  it('a compound command is named by its last meaningful segment, with every command and the segment count kept', () => {
    const f = commandFacts('cd /repo && git add -A && git commit -m "a; b && c" || echo failed');
    expect(f).toEqual({ command: 'git', subcommand: 'commit', commands: ['cd', 'git', 'git', 'echo'], segments: 4, effects: ['commit'] });
    expect(primary('npm run build && echo done')).toBe('npm run build');
    expect(primary('sleep 2; echo hi')).toBe('echo');
    expect(commandFacts('a; b\nc')?.segments).toBe(3);
  });

  it('quotes, substitutions and here-documents are not split', () => {
    expect(primary('echo "a && rm -rf /" ')).toBe('echo');
    expect(primary("git commit -m 'one; two | three'")).toBe('git commit');
    expect(primary('git commit -m "$(cat <<\'EOF\'\nfirst line; second && third\nrm -rf x\nEOF\n)"')).toBe('git commit');
    expect(commandFacts('cat > f.txt <<EOF\nrm -rf /\nEOF\nls')?.commands).toEqual(['cat', 'ls']);
    expect(primary('echo $(git rev-parse HEAD | cut -c1-7)')).toBe('echo');
  });

  it('never gives a name that is not a plain program name (a variable, a masked value, a secret)', () => {
    expect(primary('$CMD --flag')).toBe('other');
    expect(primary('[redacted] --flag')).toBe('other');
    expect(primary('git sk-ant-abcdefghijklmnopqrstuvwxyz0123456789')).toBe('git');
    expect(primary('')).toBeUndefined();
    expect(primary('   \n ')).toBeUndefined();
  });

  it('a line continued with a backslash is one line, and a comment is not a command', () => {
    expect(primary('gh pr create --draft \\\n  --title "x" \\\n  --body "y"')).toBe('gh pr create');
    expect(primary('git \\\n  commit -m "x"')).toBe('git commit');
    expect(commandFacts('# build first && rm -rf /\nnpm run build # then; echo done')).toEqual({ command: 'npm', subcommand: 'run build', commands: ['npm'], segments: 1 });
    expect(primary('echo a#b')).toBe('echo');
  });

  it('a subshell or a group is what is in it', () => {
    expect(primary('(cd pkg && npm ci)')).toBe('npm ci');
    expect(primary('{ make build; }')).toBe('make build');
  });

  it('is bounded: a very long line still answers, and lists at most 20 commands', () => {
    const f = commandFacts(Array.from({ length: 200 }, (_, i) => `cmd${i} arg`).join(' && '));
    expect(f?.commands.length).toBe(20);
    expect(f?.segments).toBe(200);
    expect(f?.command).toBe('cmd199');
  });
});
