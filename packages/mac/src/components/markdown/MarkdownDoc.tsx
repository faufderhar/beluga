import { type ReactNode, memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import type { Element, ElementContent } from 'hast';
import type { Location } from '@beluga/core/store.js';
import { Icon, type IconName } from '../Icon.js';
import { cx } from '../ui.js';
import { useBeluga } from '../../lib/beluga.js';
import { copyText } from '../../lib/copy.js';
import { openExternal } from '../../lib/system.js';
import { CodeBlock } from './CodeBlock.js';
import { Diagram } from './Diagram.js';
import { MathTex } from './MathTex.js';
import { MdImage } from './MdImage.js';
import { Outline } from './Outline.js';
import { ALERT_KINDS, ALERT_TITLES, type AlertKind } from './md-alerts.js';
import { REHYPE_PLUGINS, REMARK_PLUGINS, TO_HTML } from './md-pipeline.js';
import { findAnchor, scrollToElement } from './md-dom.js';
import { metaRows, splitFrontMatter, type MetaRow } from './md-frontmatter.js';
import { resolveLink } from './md-paths.js';
import { GraphBlock } from '../graph/GraphBlock.js';
import { isGraphFence } from '@beluga/shared/graph-spec.js';
import { MarkdownTable, ViewBlock } from '../views/ViewBlock.js';
import { InlineCode } from '../views/Inline.js';
import { viewFenceType } from '@beluga/shared/view-spec.js';
import { TASKS_FENCE } from '@beluga/shared/task-refs.js';
import { TaskCards } from '../../tasks/TaskRef.js';
import { prepareMath } from '@beluga/shared/render/math.js';
import { RichBlock, useRichFence } from '../blocks/RichBlock.js';
import m from './markdown.module.css';

/**
 * The Markdown reader: GitHub-flavored Markdown (tables, task lists, footnotes, alerts, autolinks),
 * headings you can link to, colored code, KaTeX math, Mermaid diagrams, images next to the file,
 * links that open the next page right here, and HTML only as far as GitHub allows it. Used by the
 * focus view (with an outline beside it), the panel's preview and the Files view; the chat keeps
 * its own lighter Markdown.
 */

/** Where the reader is shown: across the center (with an outline), in the panel, in the Files view. */
export type DocVariant = 'focus' | 'panel' | 'page';

/** What a link in the document opens (each place can do it its own way). */
export interface DocNav {
  readonly openDoc: (path: string, hash?: string) => void;
  readonly openFile: (path: string, line?: number) => void;
  readonly openDir: (path: string) => void;
}

const ALERT_ICONS: Record<AlertKind, IconName> = { note: 'info', tip: 'bulb', important: 'important', warning: 'alert', caution: 'stopSign' };
const KIND_BY_TITLE = new Map(ALERT_KINDS.map((k) => [ALERT_TITLES[k], k] as const));

/** A section to scroll to once the next page has opened (a link like `API.md#authentication`). */
let pending: { key: string; hash: string } | undefined;
const docKey = (at: Location): string => `${at.owner}\0${at.share}\0${at.path}`;

/** The text inside a hast node. */
const textOf = (node: ElementContent | Element | undefined): string => {
  if (!node) return '';
  if (node.type === 'text') return node.value;
  return 'children' in node ? node.children.map((c) => textOf(c as ElementContent)).join('') : '';
};

const classesOf = (el: Element | undefined): string[] => {
  const c: unknown = el?.properties?.className;
  return Array.isArray(c) ? c.map(String) : typeof c === 'string' ? c.split(' ') : [];
};

function FrontMatter({ yaml }: { yaml: string }) {
  const [rows, setRows] = useState<readonly MetaRow[]>();
  useEffect(() => {
    let alive = true;
    void import('yaml')
      .then(({ parse }) => metaRows(parse(yaml)))
      .catch(() => [{ key: '', value: yaml }])
      .then((r) => alive && setRows(r));
    return () => {
      alive = false;
    };
  }, [yaml]);
  if (!rows?.length) return null;
  return (
    <dl className={m.meta} aria-label="Front matter">
      {rows.map((r, i) => (
        <div key={`${r.key}:${i}`} className={m.metaRow}>
          <dt>{r.key}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface Ctx {
  readonly at: Location;
  readonly nav: DocNav;
  readonly anchor: (hash: string) => void;
  readonly copyLink: (id: string) => void;
}

function heading(Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6', ctx: { current: Ctx }) {
  return function Heading({ id, className, children }: { id?: string; className?: string; children?: ReactNode }) {
    // The footnotes' heading is for screen readers only (as on GitHub): no link to it.
    if (className === 'sr-only') return <Tag id={id} className={className}>{children}</Tag>;
    return (
      <Tag id={id} className={className}>
        {id ? (
          <a
            className={m.anchor}
            href={`#${id}`}
            aria-label="Copy a link to this section"
            title="Copy a link to this section"
            onClick={(e) => {
              e.preventDefault();
              ctx.current.anchor(id);
              ctx.current.copyLink(id);
            }}
          >
            <Icon name="link" size={13} />
          </a>
        ) : null}
        {children}
      </Tag>
    );
  };
}

/**
 * A fenced block that's really something else (shared/render/rich-fence.ts): a file tree, JSON, a
 * terminal session, math, or a mermaid diagram drawn as our own graph or view (else Mermaid's own).
 */
function DocFence({ code, lang }: { code: string; lang: string | undefined }) {
  const fence = useRichFence(lang, code);
  if (fence?.kind === 'math') return <MathTex tex={fence.tex} display />;
  if (fence?.kind === 'mermaid') return fence.block.kind === 'graph' ? <GraphBlock code={fence.block.text} /> : <ViewBlock code={fence.block.text} type="any" />;
  if (fence) return <RichBlock fence={fence} code={code} lang={lang} />;
  if (lang === 'mermaid') return <Diagram code={code} />;
  return <CodeBlock code={code} lang={lang} />;
}

function makeComponents(ctx: { current: Ctx }): Components {
  return {
    a: ({ href = '', children, node: _node, ...rest }) => (
      <a
        {...rest}
        href={href}
        onClick={(e) => {
          e.preventDefault();
          const { at, nav, anchor } = ctx.current;
          const link = resolveLink(href, at.path);
          if (link.kind === 'anchor') anchor(link.hash);
          else if (link.kind === 'external') void openExternal(link.url);
          else if (link.kind === 'doc') nav.openDoc(link.path, link.hash);
          else if (link.kind === 'file') nav.openFile(link.path, link.line);
          else if (link.kind === 'dir') nav.openDir(link.path);
        }}
        title={/^https?:/i.test(href) ? href : rest.title}
      >
        {children}
      </a>
    ),
    img: ({ src, alt, title }) => <MdImage src={typeof src === 'string' ? src : ''} alt={alt ?? ''} {...(title ? { title } : {})} doc={ctx.current.at} />,
    pre: ({ node }) => {
      const code = node?.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code');
      const text = textOf(code).replace(/\n$/, '');
      const lang = classesOf(code)
        .find((c) => c.startsWith('language-'))
        ?.slice('language-'.length);
      if (lang === 'math') return <MathTex tex={text} display />;
      if (isGraphFence(lang)) return <GraphBlock code={text} />;
      if (lang === TASKS_FENCE) return <TaskCards code={text} />;
      if (viewFenceType(lang)) return <ViewBlock code={text} type={viewFenceType(lang)!} />;
      return <DocFence code={text} lang={lang} />;
    },
    code: ({ className, children }) =>
      className?.includes('math-inline') ? <MathTex tex={String(children)} display={false} /> : <InlineCode text={String(children)} fallback={<code className={m.inlineCode}>{children}</code>} />,
    // A plain table sorts, searches and charts like a view (views/md-table.ts); one with links stays as written.
    table: ({ node, children }) => (
      <MarkdownTable
        node={node}
        fallback={
          <div className={m.tableWrap}>
            <table>{children}</table>
          </div>
        }
      />
    ),
    input: ({ type, checked }) => (type === 'checkbox' ? <input type="checkbox" className={m.check} checked={!!checked} readOnly disabled aria-label={checked ? 'Done' : 'Not done'} /> : null),
    p: ({ className, children }) => {
      if (className !== 'markdown-alert-title') return <p>{children}</p>;
      const kind = KIND_BY_TITLE.get(String(children)) ?? 'note';
      return (
        <p className="markdown-alert-title">
          <Icon name={ALERT_ICONS[kind]} size={15} />
          {children}
        </p>
      );
    },
    h1: heading('h1', ctx),
    h2: heading('h2', ctx),
    h3: heading('h3', ctx),
    h4: heading('h4', ctx),
    h5: heading('h5', ctx),
    h6: heading('h6', ctx),
  };
}

export interface MarkdownDocProps {
  readonly text: string;
  /** Where the file is (links and images are read from its folder). */
  readonly at: Location;
  readonly variant: DocVariant;
  /** How links to other files open (default: in the viewer, folders in Files). */
  readonly nav?: Partial<DocNav>;
}

export const MarkdownDoc = memo(function MarkdownDoc({ text, at, variant, nav }: MarkdownDocProps) {
  const { client } = useBeluga();
  const article = useRef<HTMLElement>(null);
  const { yaml, body } = useMemo(() => splitFrontMatter(text), [text]);
  // A big file re-renders behind whatever you're doing, not in its way.
  const deferred = useDeferredValue(body);
  // Math the way the chat reads it: `\(…\)` too, and prices stay words ("$5 and $10").
  const shown = useMemo(() => prepareMath(deferred), [deferred]);

  const ctx = useRef<Ctx>(null as unknown as Ctx);
  const open = (path: string): void => void client.api.files.open({ ...at, path });
  ctx.current = {
    at,
    nav: {
      openDoc: (path, hash) => {
        pending = hash ? { key: docKey({ ...at, path }), hash } : undefined;
        open(path);
      },
      openFile: (path) => open(path),
      openDir: (path) => void client.api.files.browseTo({ ...at, path }),
      ...nav,
    },
    anchor: (hash) => {
      const el = article.current && findAnchor(article.current, hash);
      if (el) scrollToElement(el, { smooth: true });
    },
    copyLink: (id) => {
      const name = at.path.split('/').pop() ?? at.path;
      void copyText(`${at.path}#${id}`).then(() => client.store.dispatch({ type: 'toast', text: `Copied a link to ${name}#${id}`, level: 'success' }));
    },
  };
  const components = useMemo(() => makeComponents(ctx), []);

  // Opened by a link to one of its sections: go there once it's drawn.
  useEffect(() => {
    if (!pending || pending.key !== docKey(at) || !article.current) return;
    const el = findAnchor(article.current, pending.hash);
    if (!el) return;
    pending = undefined;
    scrollToElement(el);
  }, [shown, at.path]);

  return (
    <div className={cx(m.reader, m[variant])} data-md>
      <article ref={article} className={cx(m.doc, 'selectable')} data-markdown-doc="">
        {yaml ? <FrontMatter yaml={yaml} /> : null}
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} remarkRehypeOptions={TO_HTML} components={components}>
          {shown}
        </ReactMarkdown>
      </article>
      {variant === 'focus' ? <Outline article={article} version={shown} /> : null}
    </div>
  );
});
