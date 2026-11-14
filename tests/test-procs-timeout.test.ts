import { afterEach, expect, it, vi } from 'vitest';

const { child, execFile } = vi.hoisted(() => {
  const child = { kill: vi.fn(), unref: vi.fn(), stdout: { destroy: vi.fn() }, stderr: { destroy: vi.fn() } };
  return { child, execFile: vi.fn((..._args: unknown[]) => child) };
});
vi.mock('node:child_process', () => ({ execFile }));
import { PS_DEADLINE_MS, stopTestProcesses } from '../src/workspaces/test-procs.js';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it.skipIf(process.platform === 'win32')('cleanup finishes when ps never closes, even after it is killed', async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const stopped = stopTestProcesses('/a/worktree');
  await vi.advanceTimersByTimeAsync(PS_DEADLINE_MS);
  expect(await stopped).toBe(0);
  // A skipped cleanup is said, not silent.
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ps didn't answer/));
  warn.mockRestore();
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  expect(child.stdout.destroy).toHaveBeenCalledOnce();
  expect(child.stderr.destroy).toHaveBeenCalledOnce();
  expect(child.unref).toHaveBeenCalledOnce();
});

it.skipIf(process.platform === 'win32')('a completed process listing clears its deadline', async () => {
  vi.useFakeTimers();
  execFile.mockImplementationOnce((...args: unknown[]) => {
    queueMicrotask(() => (args.at(-1) as (err: null, out: string) => void)(null, ''));
    return child;
  });
  expect(await stopTestProcesses('/a/worktree')).toBe(0);
  if (process.platform === 'darwin') expect(execFile.mock.calls.at(-1)?.[1]).toEqual(['-wwE', '-U', String(process.getuid!()), '-o', 'pid=,ppid=,command=']);
  await vi.advanceTimersByTimeAsync(PS_DEADLINE_MS);
  expect(child.kill).not.toHaveBeenCalled();
});
