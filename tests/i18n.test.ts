import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile, lookup } from '../packages/mac/src/i18n/match.js';
import { resolveLocale } from '../packages/mac/src/i18n/index.js';

/** The window's languages (docs/i18n.md): English in the code, other languages in catalogs. */

const catalog = (name: string): Record<string, string> => JSON.parse(readFileSync(path.join(import.meta.dirname, `../packages/mac/src/i18n/${name}.json`), 'utf8')) as Record<string, string>;

describe('lookup', () => {
  const c = compile({
    Settings: '设置',
    'Turn off': '关闭',
    'Save {0}': '保存 {0}',
    'Expires in {0} days': '{0} 天后过期',
    '{0} sub-agent{1} at work': '{0} 个子智能体在工作',
    'Step {1} of {0}': '共 {0} 步中的第 {1} 步',
    '{0} you': '{0} 你',
    Finder: '访达',
    'Show in {0}': '在 {0} 中显示',
  });

  it('finds exact text, keeping the spaces around it', () => {
    expect(lookup(c, 'Settings')).toBe('设置');
    expect(lookup(c, '  Turn off ')).toBe('  关闭 ');
    expect(lookup(c, 'Turn\n  off')).toBe('关闭');
  });

  it('fills templates, in the translation’s own order', () => {
    expect(lookup(c, 'Save notes.md')).toBe('保存 notes.md');
    expect(lookup(c, 'Expires in 3 days')).toBe('3 天后过期');
    expect(lookup(c, 'Step 2 of 5')).toBe('共 5 步中的第 2 步');
  });

  it('lets an ending after a word be empty (plurals)', () => {
    expect(lookup(c, '1 sub-agent at work')).toBe('1 个子智能体在工作');
    expect(lookup(c, '3 sub-agents at work')).toBe('3 个子智能体在工作');
  });

  it('translates a filled-in part only when it is a whole entry of its own', () => {
    expect(lookup(c, 'Show in Finder')).toBe('在访达中显示');
    expect(lookup(c, 'Show in Downloads')).toBe('在 Downloads 中显示');
  });

  it('leaves alone what it doesn’t know, and templates with too few words of their own', () => {
    expect(lookup(c, 'Hello world')).toBeUndefined();
    expect(lookup(c, 'thank you')).toBeUndefined();
    expect(lookup(c, '')).toBeUndefined();
  });
});

describe('resolveLocale', () => {
  it('follows the system for Simplified Chinese, else English', () => {
    expect(resolveLocale('system', ['zh-CN', 'en'])).toBe('zh-CN');
    expect(resolveLocale('system', ['zh-Hans-CN'])).toBe('zh-CN');
    expect(resolveLocale('system', ['zh-TW'])).toBe('en');
    expect(resolveLocale('system', ['fr-FR', 'zh-CN'])).toBe('zh-CN');
    expect(resolveLocale('system', ['en-GB', 'zh-CN'])).toBe('en');
    expect(resolveLocale('system', [])).toBe('en');
  });

  it('keeps what you picked', () => {
    expect(resolveLocale('en', ['zh-CN'])).toBe('en');
    expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN');
  });
});

describe('the zh-CN catalog', () => {
  const zh = catalog('zh-CN');

  it('uses only the placeholders its English has', () => {
    const wrong = Object.entries(zh).filter(([en, to]) => (to.match(/\{\d+\}/g) ?? []).some((p) => !en.includes(p)));
    expect(wrong).toEqual([]);
  });

  it('reads what the window puts together', () => {
    const c = compile(zh);
    const cases: Record<string, string | undefined> = {
      'zoe joined': 'zoe 加入了',
      'zoe left': 'zoe 离开了',
      '3 days left': '剩余 3 天',
      'Now: chenshizhong': '现在：chenshizhong',
      'Theme: Catppuccin Mocha': '主题：Catppuccin Mocha',
      'Run commands for Ask me each time': '运行命令（每次都问我）',
      'Read what changed': undefined,
      'Merge the fix for #48?': undefined,
    };
    for (const [en, want] of Object.entries(cases)) expect([en, lookup(c, en)]).toEqual([en, want]);
    expect(lookup(c, 'Watch that folder live in the right panel, newest first (⌥⌘6).')).toContain('(⌥⌘6)');
    expect(lookup(c, '638 MB, once. It comes by itself the first time you speak with it.')).toMatch(/^638 MB，/);
    expect(lookup(c, '14% busy')).toMatch(/繁忙/);
    expect(lookup(c, 'The number is conversations: conversations in Unread, unread notifications, and what waits on you (the Dock badge counts the same).')).not.toMatch(/Unread|notifications/);
  });

  it('leaves names people gave things as they are', () => {
    const c = compile(zh);
    expect(lookup(c, 'Read')).toBeDefined();
    c.own = new Set(['Read', 'Main']);
    c.cache.clear();
    expect(lookup(c, 'Read')).toBeUndefined();
    expect(lookup(c, 'More for Main')).toBe('Main 的更多操作');
  });

  it('gives up quickly on long text', () => {
    const c = compile(zh);
    const t = performance.now();
    lookup(c, `Waiting for ${' · '.repeat(2000)}x`);
    expect(performance.now() - t).toBeLessThan(200);
  });

  it('keeps commands as they are typed', () => {
    const wrong = Object.entries(zh).filter(([en, to]) => (en.match(/<[a-z][^>]*>/g) ?? []).some((arg) => !to.includes(arg)));
    expect(wrong).toEqual([]);
    expect(zh['On']).toBe('开');
  });

  it('has no empty translations', () => {
    expect(Object.entries(zh).filter(([, to]) => !to.trim())).toEqual([]);
  });

  it('covers the menu bar the app shell builds', () => {
    const menu = readFileSync(path.join(import.meta.dirname, '../packages/mac/src-tauri/src/menu.rs'), 'utf8');
    const labels = [...menu.matchAll(/item\(\s*app,\s*"[^"]+",\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(labels.length).toBeGreaterThan(40);
    expect(labels.filter((l) => !(l in zh) && l !== 'Beluga')).toEqual([]);
  });
});

describe('followOwnWords', () => {
  it('keeps names people gave as written, and follows renames, not every network message', async () => {
    const { useCatalog, translated } = await import('../packages/mac/src/i18n/index.js');
    const { followOwnWords } = await import('../packages/mac/src/i18n/own.js');
    useCatalog('zh-CN', { Read: '读取', Main: '主要' });
    let state: Record<string, unknown> = { network: { friends: [{ name: 'Read' }], groups: [], messages: [] } };
    const listeners: Array<() => void> = [];
    const stop = followOwnWords({ getState: () => state, subscribe: (l) => (listeners.push(l), () => undefined) });
    const changed = (next: Record<string, unknown>): void => {
      state = next;
      for (const l of listeners) l();
    };
    expect(translated('Read') ?? 'Read').toBe('Read');
    expect(translated('Main')).toBe('主要');
    // A message arrives: a new network object, the same friends.
    const friends = (state.network as { friends: unknown[] }).friends;
    changed({ network: { friends, groups: [], messages: [{ text: 'hi' }] } });
    expect(translated('Read') ?? 'Read').toBe('Read');
    // A project called Main.
    changed({ ...state, projects: [{ name: 'Main', root: '/p', workspaces: [] }] });
    expect(translated('Main') ?? 'Main').toBe('Main');
    stop();
    useCatalog('en', null);
  });
});
