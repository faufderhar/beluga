import { describe, expect, it } from 'vitest';
import { ProseView } from '../src/companion/protocol.js';
import { humanizeDoing, humanizeStep, plainLine, stepWords, stripCode, summaryWords } from '../src/companion/strip.js';

describe('stripCode', () => {
  it('takes fenced blocks out, leaving a marker with the language and line count', () => {
    const md = ['Here is the fix:', '', '```ts', 'const a = 1;', 'const b = 2;', '```', '', 'And a shell line:', '~~~', 'npm test', '~~~', 'Done, `store.ts` is fine.'].join('\n');
    const out = stripCode(md);
    expect(out.text).toBe(['Here is the fix:', '', '[[code:0]]', '', 'And a shell line:', '[[code:1]]', 'Done, `store.ts` is fine.'].join('\n'));
    expect(out.code).toEqual([{ lang: 'ts', lines: 2 }, { lines: 1 }]);
    expect(ProseView.parse(out)).toEqual(out);
  });

  it('handles longer fences, nested backticks and an unclosed block', () => {
    const md = ['````md', '```js', 'x()', '```', '````', 'after', '```python', 'print(1)', 'print(2)'].join('\n');
    const out = stripCode(md);
    expect(out.text).toBe('[[code:0]]\nafter\n[[code:1]]');
    expect(out.code).toEqual([{ lang: 'md', lines: 3 }, { lang: 'python', lines: 2 }]);
  });

  it('leaves prose without code alone', () => {
    expect(stripCode('All **24 tests** pass.')).toEqual({ text: 'All **24 tests** pass.', code: [] });
  });

  it('makes one plain line for summaries', () => {
    expect(plainLine('## Plan\n\nRun it:\n```sh\nnpm test\n```\n**done**')).toBe('Plan Run it: (code) done');
    expect(plainLine('x'.repeat(400), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('humanizeStep', () => {
  it('turns tool steps into words, never code', () => {
    expect(humanizeStep('Edit src/core/store.ts')).toBe('Edited store.ts');
    expect(humanizeStep('MultiEdit /Users/k/app/src/a.tsx')).toBe('Edited a.tsx');
    expect(humanizeStep('Write NOTES.md')).toBe('Wrote NOTES.md');
    expect(humanizeStep('Read src/server.ts')).toBe('Read server.ts');
    expect(humanizeStep('Bash npm test -- --run')).toBe('Ran the tests');
    expect(humanizeStep('Bash npm run build')).toBe('Built it');
    expect(humanizeStep('Bash npx tsc --noEmit')).toBe('Checked the types');
    expect(humanizeStep('Bash git status --short')).toBe('Ran git status');
    expect(humanizeStep('Bash FOO=1 ./scripts/build.sh --all')).toBe('Ran ./scripts/build.sh');
    expect(humanizeStep('Bash sqlite3 payments.db ".tables"')).toBe('Ran sqlite3');
    expect(humanizeStep('Grep "TODO"')).toBe('Searched for TODO');
    expect(humanizeStep('Glob src/**/*.ts')).toBe('Looked for files');
    expect(humanizeStep('WebFetch https://example.com/docs')).toBe('Read a page on example.com');
    expect(humanizeStep('mcp__beluga__show')).toBe('Used show');
    expect(humanizeStep('mcp__beluga_board__task_define Protect the payment routes')).toBe('Used task define');
    expect(humanizeStep('task_define Protect the payment routes')).toBe('Used task define');
    expect(humanizeStep('24 passed')).toBe('24 passed');
  });

  it('says what a step is doing, with its tool, for the live view', () => {
    expect(stepWords('Edit src/core/store.ts')).toEqual({ did: 'Edited store.ts', doing: 'Editing store.ts', tool: 'edit' });
    expect(stepWords('Bash npx vitest run tests/a.test.ts')).toEqual({ did: 'Ran the tests', doing: 'Running the tests', tool: 'test' });
    expect(stepWords('Grep "retry"').tool).toBe('search');
    expect(stepWords('Agent Check the webhooks')).toMatchObject({ doing: 'Starting a sub-agent: Check the webhooks', tool: 'agent' });
    expect(stepWords('mcp__beluga__show').tool).toBe('tool');
  });

  it("puts Claude Code's words for an agent's step in the phone's, never a command line or a path", () => {
    expect(humanizeDoing('Reading src/core/store.ts')).toEqual({ text: 'Reading store.ts', tool: 'read' });
    expect(humanizeDoing('Editing packages/companion/app/ask.tsx')).toEqual({ text: 'Editing ask.tsx', tool: 'edit' });
    expect(humanizeDoing('Running npm test -- --run --reporter=dot')).toEqual({ text: 'Running the tests', tool: 'test' });
    expect(humanizeDoing('Running rm -rf dist && ./scripts/deploy.sh --prod')).toEqual({ text: 'Running rm', tool: 'run' });
    expect(humanizeDoing('Searching for retry in src/core')).toEqual({ text: 'Searching for retry', tool: 'search' });
    expect(humanizeDoing('Fetching https://example.com/private/path?token=x')).toEqual({ text: 'Reading a page on example.com', tool: 'web' });
    expect(humanizeDoing('Agent: Fix the sidebar')).toEqual({ text: 'Starting a sub-agent: Fix the sidebar', tool: 'agent' });
    expect(humanizeDoing('Run the unit tests')).toEqual({ text: 'Run the unit tests', tool: 'test' });
  });

  it('keeps the words of a linked chat picture, not the link the phone cannot open', () => {
    expect(stripCode('the error [📎 image 1 (png, 6K)](klaud-attachment:F5W6TU1pJG/checkout-error.png) on staging').text).toBe('the error 📎 image 1 (png, 6K) on staging');
  });
});

describe('an MCP App step on the phone', () => {
  it('reads "<tool> app, on your Mac" for a step with an app', () => {
    expect(summaryWords({ title: 'mcp__basic__get-time', hasApp: true })).toEqual({ did: 'Get time app, on your Mac', doing: 'Get time app, on your Mac', tool: 'tool' });
    expect(summaryWords({ title: 'mcp__claude_ai_Slack__slack_send_message_draft {"x":1}', hasApp: true }).did).toBe('Slack send message draft app, on your Mac');
  });

  it('keeps today’s line for a step without an app', () => {
    expect(summaryWords({ title: 'mcp__basic__get-time' })).toEqual({ did: 'Used get time', doing: 'Using get time', tool: 'tool' });
    expect(summaryWords({ title: 'Edit src/core/store.ts' })).toEqual(stepWords('Edit src/core/store.ts'));
  });
});
