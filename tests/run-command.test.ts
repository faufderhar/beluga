import { describe, expect, it } from 'vitest';
import { runnableCommand, shellInput } from '../src/shared/render/run-command.js';
import { RUN_WAIT_MS, sendRun, takeRuns } from '../packages/mac/src/lib/term-run-queue.js';

describe('runnableCommand', () => {
  it('runs a shell code block as written', () => {
    expect(runnableCommand('bash', 'npm install\nnpm test\n')).toBe('npm install\nnpm test');
    expect(runnableCommand('sh', 'ls -la')).toBe('ls -la');
    expect(runnableCommand('zsh', 'echo hi')).toBe('echo hi');
    expect(runnableCommand('shell', 'echo hi')).toBe('echo hi');
  });

  it('never runs code that is not a shell', () => {
    expect(runnableCommand('ts', 'console.log(1)')).toBeUndefined();
    expect(runnableCommand('python', 'print(1)')).toBeUndefined();
    expect(runnableCommand('ts', 'npm install')).toBeUndefined();
  });

  it('runs a block with no language when every line reads as a command (Claude often leaves it off)', () => {
    expect(runnableCommand(undefined, 'npm install\nnpm run dev')).toBe('npm install\nnpm run dev');
    expect(runnableCommand('', 'brew install gh')).toBe('brew install gh');
    expect(runnableCommand('text', 'cd packages/mac && npm run app:dev')).toBe('cd packages/mac && npm run app:dev');
    expect(runnableCommand(undefined, './scripts/setup.sh --fast')).toBe('./scripts/setup.sh --fast');
    expect(runnableCommand(undefined, 'docker run \\\n  -p 80:80 nginx')).toBe('docker run \\\n  -p 80:80 nginx');
    expect(runnableCommand(undefined, '$ git status')).toBe('git status');
  });

  it('leaves a block with no language alone when it reads as prose, config or code', () => {
    expect(runnableCommand(undefined, 'Hello there')).toBeUndefined();
    expect(runnableCommand(undefined, 'PORT=3000\nHOST=localhost')).toBeUndefined();
    expect(runnableCommand('', 'npm install\nthen open the app')).toBeUndefined();
    expect(runnableCommand('text', 'const x = 1;')).toBeUndefined();
    expect(runnableCommand(undefined, 'git')).toBe('git');
    expect(runnableCommand(undefined, 'gitignore entries')).toBeUndefined();
  });

  it('takes the prompts off when every command has one', () => {
    expect(runnableCommand('bash', '$ npm ci\n$ npm test')).toBe('npm ci\nnpm test');
    expect(runnableCommand('sh', '% make')).toBe('make');
  });

  it('leaves comment-only lines and blank lines out (zsh runs `#` as a command)', () => {
    expect(runnableCommand('bash', '# install first\nnpm ci\n\n# then\nnpm test')).toBe('npm ci\nnpm test');
    expect(runnableCommand('bash', '# only a note')).toBeUndefined();
    expect(runnableCommand('bash', '   \n')).toBeUndefined();
  });

  it('keeps a command that goes on over several lines', () => {
    expect(runnableCommand('bash', 'docker run \\\n  -p 80:80 \\\n  nginx')).toBe('docker run \\\n  -p 80:80 \\\n  nginx');
  });

  it('runs only the commands of a session, never what it printed', () => {
    expect(runnableCommand('console', '$ npm test\n✓ 12 passed\n$ git status\nnothing to commit')).toBe('npm test\ngit status');
    expect(runnableCommand('bash', '$ ls\nREADME.md  src')).toBe('ls');
  });

  it('has nothing to run in output alone', () => {
    expect(runnableCommand('console', 'error: something broke')).toBeUndefined();
    expect(runnableCommand('output', 'done')).toBeUndefined();
    // A log is something that happened, not something to do again.
    expect(runnableCommand('log', '$ make\nok')).toBeUndefined();
    expect(runnableCommand('stdout', '$ make')).toBeUndefined();
  });
});

describe('shellInput', () => {
  it('clears the line, then presses Return after each line', () => {
    expect(shellInput('npm test')).toBe('\x15npm test\r');
    expect(shellInput('a\nb')).toBe('\x15a\rb\r');
  });
});

describe('the run queue (a terminal that takes runs)', () => {
  it('types straight into the terminal that is showing', () => {
    const typed: string[] = [];
    const stop = takeRuns((d) => typed.push(d));
    sendRun('ls\r');
    expect(typed).toEqual(['ls\r']);
    stop();
  });

  it('waits for a terminal that is still coming (the drawer sliding in)', () => {
    sendRun('npm test\r', 1000);
    const typed: string[] = [];
    const stop = takeRuns((d) => typed.push(d), 1500);
    expect(typed).toEqual(['npm test\r']);
    stop();
    // Taken once: the next terminal doesn't run it again.
    const again: string[] = [];
    const stop2 = takeRuns((d) => again.push(d), 1600);
    expect(again).toEqual([]);
    stop2();
  });

  it('drops a run no terminal came for in time (never runs it much later)', () => {
    sendRun('make\r', 0);
    const typed: string[] = [];
    const stop = takeRuns((d) => typed.push(d), RUN_WAIT_MS + 1);
    expect(typed).toEqual([]);
    stop();
  });

  it('gives it to the newest terminal, and to none once they are gone', () => {
    const first: string[] = [];
    const second: string[] = [];
    const stopFirst = takeRuns((d) => first.push(d));
    const stopSecond = takeRuns((d) => second.push(d));
    sendRun('a\r');
    expect(second).toEqual(['a\r']);
    expect(first).toEqual([]);
    stopSecond();
    stopFirst();
    sendRun('b\r', 0);
    expect(first).toEqual([]);
    // Left waiting for the next one, not lost.
    const later: string[] = [];
    takeRuns((d) => later.push(d), 10)();
    expect(later).toEqual(['b\r']);
  });
});
