import { describe, expect, it } from 'vitest';
import { type MdNode, parseAlertMarker, remarkAlerts, toAlert, withAlerts } from '../packages/mac/src/components/markdown/md-alerts.js';
import { hastText } from '../packages/mac/src/components/markdown/hast-text.js';
import { metaRows, splitFrontMatter } from '../packages/mac/src/components/markdown/md-frontmatter.js';
import { anchorIds, dirOf, isMarkdownPath, joinPath, resolveImage, resolveLink } from '../packages/mac/src/components/markdown/md-paths.js';

const text = (value: string): MdNode => ({ type: 'text', value });
const para = (...children: MdNode[]): MdNode => ({ type: 'paragraph', children });
const quote = (...children: MdNode[]): MdNode => ({ type: 'blockquote', children });

describe('Markdown links in the reader', () => {
  const doc = 'docs/GUIDE.md';

  it('works out folders, dots and the top of the share', () => {
    expect(dirOf('docs/GUIDE.md')).toBe('docs');
    expect(dirOf('README.md')).toBe('');
    expect(joinPath('docs', 'api/auth.md')).toBe('docs/api/auth.md');
    expect(joinPath('docs', './a/../b.md')).toBe('docs/b.md');
    expect(joinPath('docs/deep', '../../README.md')).toBe('README.md');
    expect(joinPath('docs', '/src/server.ts')).toBe('src/server.ts');
    expect(joinPath('docs', 'a//b')).toBe('docs/a/b');
  });

  it('never climbs out of the share', () => {
    expect(joinPath('docs', '../../etc/passwd')).toBeUndefined();
    expect(joinPath('', '../x.md')).toBeUndefined();
    expect(resolveLink('../../secret.md', doc)).toEqual({ kind: 'blocked' });
    expect(resolveImage('../../../x.png', doc)).toEqual({ kind: 'blocked' });
  });

  it('opens other Markdown in the reader, keeping the section', () => {
    expect(resolveLink('api.md', doc)).toEqual({ kind: 'doc', path: 'docs/api.md' });
    expect(resolveLink('../README.md#getting-started', doc)).toEqual({ kind: 'doc', path: 'README.md', hash: 'getting-started' });
    expect(resolveLink('./Other%20Notes.markdown', doc)).toEqual({ kind: 'doc', path: 'docs/Other Notes.markdown' });
    expect(resolveLink('/NOTES.md?plain=1', doc)).toEqual({ kind: 'doc', path: 'NOTES.md' });
    expect(isMarkdownPath('a/b.MD')).toBe(true);
  });

  it('stays on the page for its own sections', () => {
    expect(resolveLink('#tables', doc)).toEqual({ kind: 'anchor', hash: 'tables' });
    expect(resolveLink('GUIDE.md#math', doc)).toEqual({ kind: 'anchor', hash: 'math' });
    expect(resolveLink('#caf%C3%A9', doc)).toEqual({ kind: 'anchor', hash: 'café' });
    expect(resolveLink('#', doc)).toEqual({ kind: 'blocked' });
  });

  it('opens other files and folders in Files, with GitHub line anchors', () => {
    expect(resolveLink('../src/server.ts', doc)).toEqual({ kind: 'file', path: 'src/server.ts' });
    expect(resolveLink('../src/server.ts#L4-L6', doc)).toEqual({ kind: 'file', path: 'src/server.ts', line: 4 });
    expect(resolveLink('../src/', doc)).toEqual({ kind: 'dir', path: 'src' });
    expect(resolveLink('..', doc)).toEqual({ kind: 'dir', path: '' });
  });

  it('sends web links to the browser and refuses other schemes', () => {
    expect(resolveLink('https://example.com/a?b#c', doc)).toEqual({ kind: 'external', url: 'https://example.com/a?b#c' });
    expect(resolveLink('mailto:kay@example.com', doc)).toEqual({ kind: 'external', url: 'mailto:kay@example.com' });
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>', '//evil.example/x', '  ', 'vscode://x']) {
      expect(resolveLink(bad, doc)).toEqual({ kind: 'blocked' });
    }
  });

  it('reads images next to the file, or over https', () => {
    expect(resolveImage('assets/diagram.svg', doc)).toEqual({ kind: 'local', path: 'docs/assets/diagram.svg' });
    expect(resolveImage('../design/sunset.svg', doc)).toEqual({ kind: 'local', path: 'design/sunset.svg' });
    expect(resolveImage('/design/sunset.svg?raw=true', doc)).toEqual({ kind: 'local', path: 'design/sunset.svg' });
    expect(resolveImage('https://img.shields.io/badge/x-y-green.svg', doc)).toEqual({ kind: 'remote', url: 'https://img.shields.io/badge/x-y-green.svg' });
    for (const bad of ['http://tracker.example/p.gif', 'file:///Users/me/a.png', 'data:image/png;base64,AAAA', '../src/server.ts', '', 'javascript:x']) {
      expect(resolveImage(bad, doc)).toEqual({ kind: 'blocked' });
    }
  });

  it('finds footnote and heading ids behind a hash', () => {
    expect(anchorIds('fn-1')).toEqual(['fn-1', 'user-content-fn-1', 'fn-1']);
    expect(anchorIds('#user-content-fnref-1')).toEqual(['user-content-fnref-1', 'fnref-1']);
    expect(anchorIds('Tables')).toContain('tables');
  });
});

describe('GitHub alerts', () => {
  it('reads the marker on the first line', () => {
    expect(parseAlertMarker('[!NOTE]\nBody')).toEqual({ kind: 'note', length: 8 });
    expect(parseAlertMarker('[!tip]')).toEqual({ kind: 'tip', length: 6 });
    expect(parseAlertMarker('  [!Warning]  \r\nx')?.kind).toBe('warning');
    expect(parseAlertMarker('[!IMPORTANT]\n')?.kind).toBe('important');
    expect(parseAlertMarker('[!CAUTION]\n')?.kind).toBe('caution');
    // Not alone on its line, unknown, or not first: an ordinary quote.
    expect(parseAlertMarker('[!NOTE] same line')).toBeUndefined();
    expect(parseAlertMarker('[!DANGER]\nx')).toBeUndefined();
    expect(parseAlertMarker('Hi [!NOTE]\nx')).toBeUndefined();
  });

  it('turns the quote into a titled callout and keeps the rest', () => {
    const alert = toAlert(quote(para(text('[!WARNING]\nMind the '), { type: 'strong', children: [text('gap')] }), para(text('Second'))));
    expect(alert?.data).toEqual({ hName: 'div', hProperties: { className: ['markdown-alert', 'markdown-alert-warning'] } });
    expect(alert?.children?.[0]).toEqual({ type: 'paragraph', data: { hProperties: { className: ['markdown-alert-title'] } }, children: [text('Warning')] });
    expect(alert?.children?.[1]).toEqual(para(text('Mind the '), { type: 'strong', children: [text('gap')] }));
    expect(alert?.children?.[2]).toEqual(para(text('Second')));
  });

  it('drops a marker that was the whole first paragraph, even split across text nodes', () => {
    const alert = toAlert(quote(para(text('['), text('!TIP'), text(']')), para(text('Use it'))));
    expect(alert?.children?.map((c) => c.children?.[0]?.value)).toEqual(['Tip', 'Use it']);
  });

  it('leaves ordinary quotes and other nodes alone, without changing the tree it was given', () => {
    const plain = quote(para(text('Just a quote')));
    expect(toAlert(plain)).toBeUndefined();
    expect(toAlert(para(text('[!NOTE]\nx')))).toBeUndefined();
    expect(toAlert(quote())).toBeUndefined();
    const tree: MdNode = { type: 'root', children: [plain, quote(para(text('[!NOTE]\nnested')))] };
    const before = JSON.stringify(tree);
    const out = withAlerts(tree);
    expect(JSON.stringify(tree)).toBe(before);
    expect(out.children?.[0]).toEqual(plain);
    expect(out.children?.[1]?.data?.hName).toBe('div');
    expect(remarkAlerts()(tree).children?.[1]?.children?.[0]?.children?.[0]?.value).toBe('Note');
  });
});

describe('front matter', () => {
  it('splits the YAML off the top', () => {
    expect(splitFrontMatter('---\ntitle: Guide\ntags: [a, b]\n---\n# Hi\n')).toEqual({ yaml: 'title: Guide\ntags: [a, b]', body: '# Hi\n', lines: 4 });
    expect(splitFrontMatter('---\na: 1\n...\nbody')).toMatchObject({ yaml: 'a: 1', body: 'body' });
    expect(splitFrontMatter('# No front matter\n---\n')).toEqual({ body: '# No front matter\n---\n', lines: 0 });
    expect(splitFrontMatter('text\n---\na: 1\n---\n').yaml).toBeUndefined();
  });

  it('shows it as rows', () => {
    expect(metaRows({ title: 'Guide', tags: ['a', 'b'], draft: false, date: new Date('2026-10-01T00:00:00Z'), owner: { name: 'kay' }, none: null })).toEqual([
      { key: 'title', value: 'Guide' },
      { key: 'tags', value: 'a, b' },
      { key: 'draft', value: 'false' },
      { key: 'date', value: '2026-10-01' },
      { key: 'owner', value: '{"name":"kay"}' },
      { key: 'none', value: '' },
    ]);
    expect(metaRows('just text')).toEqual([{ key: '', value: 'just text' }]);
    expect(metaRows(null)).toEqual([]);
  });
});

describe('the reader’s HTML (the same plugins the Mac app renders with)', async () => {
  // The Mac app's own packages (its reader is built from them; klaud's terminal UI doesn't use them).
  const [{ unified }, { default: remarkParse }, { default: remarkRehype }, { toHtml }, { REHYPE_PLUGINS, REMARK_PLUGINS, TO_HTML }] = await Promise.all([
    import('../packages/mac/node_modules/unified/index.js'),
    import('../packages/mac/node_modules/remark-parse/index.js'),
    import('../packages/mac/node_modules/remark-rehype/index.js'),
    import('../packages/mac/node_modules/hast-util-to-html/index.js'),
    import('../packages/mac/src/components/markdown/md-pipeline.js'),
  ]);
  const render = async (md: string): Promise<string> => {
    const proc = unified().use(remarkParse).use(REMARK_PLUGINS).use(remarkRehype, { ...TO_HTML, allowDangerousHtml: true }).use(REHYPE_PLUGINS);
    return toHtml(await proc.run(proc.parse(md)));
  };

  it('keeps GitHub’s safe HTML and drops scripts, handlers, styles and frames', async () => {
    const html = await render(
      ['<details><summary>More</summary>\n\nHidden <kbd>⌘</kbd></details>', '', '<script>alert(1)</script>', '<img src="x.png" onerror="alert(1)" alt="x">', '<a href="javascript:alert(1)">bad</a> <iframe src="https://evil.example"></iframe>', '<p style="color:red" onclick="x()">styled</p>'].join('\n'),
    );
    expect(html).toContain('<details><summary>More</summary>');
    expect(html).toContain('<kbd>⌘</kbd>');
    expect(html).not.toMatch(/<script|onerror|onclick|style=|<iframe|javascript:/i);
    expect(html).toContain('<img src="x.png" alt="x">');
  });

  it('gives headings ids, alerts their classes, math its markers, and footnotes matching links', async () => {
    const html = await render('# Getting started\n\n> [!TIP]\n> Use it\n\nInline $x^2$ and\n\n$$\ny\n$$\n\nNote[^1]\n\n[^1]: The note.\n');
    expect(html).toContain('<h1 id="getting-started">Getting started</h1>');
    expect(html).toMatch(/<div class="markdown-alert markdown-alert-tip">\s*<p class="markdown-alert-title">Tip<\/p>\s*<p>Use it<\/p>/);
    expect(html).toContain('<code class="language-math math-inline">x^2</code>');
    expect(html).toContain('<code class="language-math math-display">y</code>');
    // The link says #fn-1, the note's id carries the sanitizer's prefix (the reader looks for both).
    expect(html).toMatch(/href="#fn-1"/);
    expect(html).toMatch(/id="user-content-fn-1"/);
  });

  it('can’t borrow the reader’s classes for anything else', async () => {
    const html = await render('<div class="markdown-alert-danger evil">x</div>\n\n<code class="language-js other">y</code>');
    expect(html).not.toMatch(/markdown-alert|evil|other/);
    expect(html).toContain('<code class="language-js">y</code>');
  });
});

describe('GitHub’s words in the app (issues, PR comments)', async () => {
  const [{ unified }, { default: remarkParse }, { default: remarkRehype }, { toHtml }, { default: remarkGfm }, { GITHUB_REHYPE, TO_HTML }] = await Promise.all([
    import('../packages/mac/node_modules/unified/index.js'),
    import('../packages/mac/node_modules/remark-parse/index.js'),
    import('../packages/mac/node_modules/remark-rehype/index.js'),
    import('../packages/mac/node_modules/hast-util-to-html/index.js'),
    import('../packages/mac/node_modules/remark-gfm/index.js'),
    import('../packages/mac/src/components/markdown/md-pipeline.js'),
  ]);
  const tree = async (md: string) => {
    const proc = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { ...TO_HTML, allowDangerousHtml: true }).use(GITHUB_REHYPE);
    return proc.run(proc.parse(md));
  };

  it('draws an issue pasted as a whole HTML page, without its page tags or comments', async () => {
    const body = '<html>\n<body>\n<!--StartFragment--><html><head></head><body><h1><span>Bug</span></h1><ul><li><p><strong><span>OS:</span></strong><span> Windows 11</span></p></li></ul><pre><code><span>error creating thread:\nrefusing</span></code></pre><script>alert(1)</script><p onclick="x()">Done</p></body></html><!--EndFragment-->\n</body>\n</html>';
    const html = toHtml(await tree(body));
    expect(html).toContain('<h1><span>Bug</span></h1>');
    expect(html).toContain('<li><p><strong><span>OS:</span></strong><span> Windows 11</span></p></li>');
    expect(html).not.toMatch(/<html|<head|<body|<!--|<script|onclick/i);
    expect(html).toContain('<p>Done</p>');
  });

  it('keeps Markdown issues as they were', async () => {
    const html = toHtml(await tree('## Steps\n\n| Test | Result |\n| -- | -- |\n| Chat | Works |\n\n`npm test`'));
    expect(html).toContain('<h2>Steps</h2>');
    expect(html).toContain('<td>Works</td>');
    expect(html).toContain('<code>npm test</code>');
  });

  it('reads the text of code whose words sit in spans', async () => {
    const root = await tree('<pre><code><span>error:</span>\n<span>refusing</span></code></pre>');
    const find = (n: { type: string; tagName?: string; children?: unknown[] }): typeof n | undefined =>
      n.tagName === 'code' ? n : (n.children as (typeof n)[] | undefined)?.map(find).find(Boolean);
    expect(hastText(find(root) as Parameters<typeof hastText>[0])).toBe('error:\nrefusing');
    expect(hastText({ type: 'text', value: 'x' })).toBe('x');
    expect(hastText(undefined)).toBe('');
  });
});
