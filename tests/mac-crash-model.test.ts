import { describe, expect, it } from 'vitest';
import { crashOf } from '../packages/mac/src/lib/crash-model.js';
import { API } from '../src/ipc/api.js';

/** A part of the window that threw while drawing, as the black box keeps it (packages/mac/src/lib/crash-model.ts, BLG-905). */

const args = API['diagnostics.windowCrash'].args;

describe('a crash in the window, noted for the black box', () => {
  it('says which part, its error, where in the code and in which components', () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'name')");
    error.stack = `TypeError: Cannot read properties of undefined (reading 'name')\n    at Row (NotificationCenter.tsx:87:20)\n    at renderWithHooks (react-dom.js:1:1)`;
    const crash = crashOf('notifications', error, '\n    at Row\n    at ul\n    at Center');
    expect(crash).toEqual({
      part: 'notifications',
      message: "Cannot read properties of undefined (reading 'name')",
      stack: "TypeError: Cannot read properties of undefined (reading 'name')\nat Row (NotificationCenter.tsx:87:20)\nat renderWithHooks (react-dom.js:1:1)\ncomponents:\nat Row\nat ul\nat Center",
    });
    expect(args.safeParse([crash]).success).toBe(true);
  });

  it('takes what was thrown even when it is not an Error', () => {
    expect(crashOf('window', 'boom')).toEqual({ part: 'window', message: 'boom' });
    expect(crashOf('window', new Error(''))).toMatchObject({ message: 'Unknown error' });
  });

  it('stays within what the daemon takes, however long the stack', () => {
    const error = new Error('x'.repeat(5000));
    error.stack = Array.from({ length: 200 }, (_, i) => `    at f${i} (${'y'.repeat(400)})`).join('\n');
    const crash = crashOf('p'.repeat(300), error, Array.from({ length: 50 }, (_, i) => `at C${i}`).join('\n'));
    expect(crash.part).toHaveLength(200);
    expect(crash.message).toHaveLength(1000);
    expect(crash.stack!.length).toBeLessThanOrEqual(4000);
    expect(args.safeParse([crash]).success).toBe(true);
  });
});
