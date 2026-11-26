import { useCallback } from 'react';
import { shellInput } from '@beluga/shared/render/run-command.js';
import { toast, useBeluga } from './beluga.js';
import { type PanelState, revealTerminal } from './panel.js';
import { sendRun } from './term-run-queue.js';

/**
 * Run from a chat's code block (BLG-968): the terminal shows where ⌘J keeps it (the drawer or the
 * panel), the command is typed into the shell it shows (term-run-queue.ts holds it until then) and
 * the keyboard goes there, to answer what it asks or stop it.
 */

/** Show the terminal and run the command in it → why not, when there's no terminal here. */
export function runInTerminal(state: PanelState, command: string): string | undefined {
  if (state.view.kind === 'shared') return 'A shared workspace’s terminal is its owner’s';
  if (!revealTerminal(state, true)) return 'No terminal here';
  sendRun(shellInput(command));
  return undefined;
}

/** Run a command in the terminal here, saying why not when it can't (a shared workspace, no terminal). */
export function useRunInTerminal(): (command: string) => void {
  const { client } = useBeluga();
  return useCallback(
    (command: string) => {
      const why = runInTerminal(client.store.getState(), command);
      if (why) toast(client, why, 'warn');
    },
    [client],
  );
}
