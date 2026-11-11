import { describe, expect, it } from 'vitest';
import { bm25Ranking, searchWords, toolText, type SearchableTool } from '../src/external/domain/tool-search.js';

const tool = (name: string, description: string, properties: Record<string, unknown> = {}): SearchableTool => ({ name, description, inputSchema: { type: 'object', properties } });

const TOOLS: readonly SearchableTool[] = [
  tool('sentinel_remove', 'Delete a sentinel: it stops watching.', { id: { type: 'string', description: 'The sentinel' } }),
  tool('sentinel_pause', 'Pause a sentinel until the user turns it back on.', { id: { type: 'string' } }),
  tool('task_note', 'Leave a note on a task’s activity.', { key: { type: 'string' }, text: { type: 'string' } }),
  tool('phone_screenshot', 'A screenshot of the phone’s screen.'),
  tool('worktree_stop_run', 'Stop a worktree’s run script.', { worktree: { type: 'string', enum: ['blg-12-login'] } }),
];

describe('tool search (BM25)', () => {
  const rank = bm25Ranking(TOOLS);

  it('puts the tool whose name and words match first', () => {
    expect(rank('pause the sentinel')[0]).toBe('sentinel_pause');
    expect(rank('delete a sentinel')[0]).toBe('sentinel_remove');
    expect(rank('leave a note on a task')[0]).toBe('task_note');
  });

  it('finds by schema words: property names, descriptions and enum values', () => {
    expect(rank('blg-12-login')).toEqual(['worktree_stop_run']);
    expect(toolText(TOOLS[0]!)).toContain('The sentinel');
    expect(toolText(TOOLS[0]!)).not.toMatch(/\bstring\b/);
  });

  it('folds plurals and case, and leaves out stop words', () => {
    expect(searchWords('The Sentinels of my TASKS, entries')).toEqual(['sentinel', 'task', 'entry']);
    expect(rank('SCREENSHOTS')[0]).toBe('phone_screenshot');
  });

  it('leaves out a tool that shares no word, and returns nothing for an empty or stop-word query', () => {
    expect(rank('pause')).toEqual(['sentinel_pause']);
    expect(rank('')).toEqual([]);
    expect(rank('what is the')).toEqual([]);
    expect(rank('kubernetes')).toEqual([]);
  });

  it('breaks a tie by name, so the same query always gives the same order', () => {
    const twins = bm25Ranking([tool('b_tool', 'Same words.'), tool('a_tool', 'Same words.')]);
    expect(twins('same words')).toEqual(['a_tool', 'b_tool']);
  });

  it('copes with no tools', () => {
    expect(bm25Ranking([])('anything')).toEqual([]);
  });
});
