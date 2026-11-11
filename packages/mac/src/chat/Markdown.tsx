import { baseName, endsWithSep, isAbsolutePath } from '@beluga/shared/os-path.js';
import { Suspense, createContext, lazy, memo, useContext, useEffect, useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { ATTACHMENT_SCHEME } from '@beluga/core/attachment-share.js';
import type { LinkTarget } from '@beluga/shared/link-target.js';
import { parseAttachmentHref } from '@beluga/shared/attachment-links.js';
import { Icon } from '../components/Icon.js';
import { type ChatImage, openLightbox } from './images.js';
import { Thumb } from './ChatImages.js';
import { ImageChip } from './ImageChip.js';
import { imageSource, localImage, messageImages } from './md-images.js';
import { useActions } from '../lib/actions.js';
import { ActionsContext, type ActionItem } from '../components/SpecMenu.js';
import { copyText } from '../lib/copy.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { MentionPill } from './Mention.js';
import { type MentionWorld, linkMentions, parseMentionHref } from './mentions.js';
import { quoteInBox } from './message-menu.js';
import { keepBlankLines } from './typed-lines.js';
import { GraphBlock } from '../components/graph/GraphBlock.js';
import { isGraphFence } from '@beluga/shared/graph-spec.js';
import { MarkdownTable, ViewBlock } from '../components/views/ViewBlock.js';
import { InlineCode } from '../components/views/Inline.js';
import { viewFenceType } from '@beluga/shared/view-spec.js';
import { TASKS_FENCE, TASK_LINK_SCHEME, linkTaskKeys } from '@beluga/shared/task-refs.js';
import { codeWorktreeRefs } from '@beluga/shared/worktree-refs.js';
import { TaskCards, TaskKeyChip } from '../tasks/TaskRef.js';
import { prepareMath, splitInlineMath } from '@beluga/shared/render/math.js';
import { MathTex } from '../components/markdown/MathTex.js';
import { Diagram } from '../components/markdown/Diagram.js';
import { hastText } from '../components/markdown/hast-text.js';
import { GITHUB_REHYPE, TO_HTML } from '../components/markdown/md-pipeline.js';
import { RichBlock, useRichFence } from '../components/blocks/RichBlock.js';
import { loadHighlighter } from '../lib/highlight.js';
import { CODE_FENCE } from '@beluga/shared/code-ref.js';
import { CodeRefBlock } from '../components/code/CodeRefBlock.js';
import { PR_COMMENTS_FENCE } from '@beluga/shared/pr-comments-ref.js';
import { PrCommentsBlock } from '../pr/PrCommentsBlock.js';
import { PREVIEW_FENCE } from '@beluga/shared/preview/ref.js';
import { PreviewNotice, usePreviewHere } from '../components/preview/PreviewNotice.js';
import { linkPaths, parsePathHref } from '@beluga/shared/render/path-refs.js';
import { PathLink } from './PathLink.js';
import s from './chat.module.css';
import { thisComputer } from '../lib/os-words.js';


function Code({ code, lang }: { code: string; lang?: string }) {
  const [html, setHtml] = useState<string | undefined>();
  useEffect(() => {
    if (!lang) return;
    let alive = true;
    void loadHighlighter().then(async (h) => {
      const id = await h.language(lang);
      if (alive && id) setHtml(h.codeToHtml(code, id));
    });
    return () => {
      alive = false;
    };
  }, [code, lang]);
  const { client, ui } = useBeluga();
  const say = (text: string): void => client.store.dispatch({ type: 'toast', text, level: 'success' });
  const copy = (text: string, what: string): void => void copyText(text).then(() => say(`Copied ${what}`));
  const fence = `\`\`\`${lang ?? ''}\n${code}\n\`\`\``;
  const items: ActionItem[] = [
    { label: 'Copy Code', icon: 'copy', onSelect: () => copy(code, 'the code') },
    { label: 'Copy as Markdown', onSelect: () => copy(fence, 'as Markdown') },
    { label: 'Quote in Reply', icon: 'chat', separate: true, onSelect: () => quoteInBox(ui, fence) },
  ];
  return (
    <ActionsContext items={items}>
      <div className={s.codeBlock}>
        <button type="button" className={s.copyCode} onClick={() => copy(code, 'the code')} aria-label="Copy code">
          Copy
        </button>
        {/* eslint-disable-next-line react/no-danger */}
        {html ? <div className={s.shiki} dangerouslySetInnerHTML={{ __html: html }} /> : <pre><code>{code}</code></pre>}
      </div>
    </ActionsContext>
  );
}

/** Where a markdown link goes: a web page, an image someone sent, or a file in a share. */
function targetOf(href: string): LinkTarget {
  if (/^https?:\/\//i.test(href)) return { kind: 'url', url: href };
  if (href.startsWith(ATTACHMENT_SCHEME)) {
    const rest = href.slice(ATTACHMENT_SCHEME.length);
    const at = rest.indexOf('/');
    return { kind: 'attachment', owner: rest.slice(0, at), file: rest.slice(at + 1), label: 'image' };
  }
  if (isAbsolutePath(href) || href.startsWith('~')) return { kind: 'local', path: href, dir: endsWithSep(href) };
  return { kind: 'href', href };
}

/** An image in the text: a file on this Mac as a thumbnail (click for full size), else a quiet chip. */
function MdImage({ src, alt, all, local }: { src: string; alt: string; all: readonly ChatImage[]; local: boolean }) {
  const actions = useActions();
  const source = imageSource(src);
  // Someone else's message never makes this Mac read its own files (a path to your screenshot, say).
  if (source.kind === 'local' && !local) {
    return (
      <span className={s.imageRef} title={`${source.path} (pictures on ${thisComputer()} show only in your own and your agent’s messages)`}>
        <Icon name="image" size={11} />
        {alt || baseName(source.path)}
      </span>
    );
  }
  if (source.kind === 'local') {
    const index = all.findIndex((i) => i.local === source.path);
    const image = all[index] ?? localImage(source.path, alt);
    return <Thumb image={image} all={index < 0 ? [image] : all} index={Math.max(0, index)} tiled={false} />;
  }
  // The window only loads what Beluga reads for it, so a web image opens in the browser instead.
  if (source.kind === 'remote') {
    return (
      <a href={source.url} className={s.imageRef} title={source.url} onClick={(e) => (e.preventDefault(), actions.openLink({ kind: 'url', url: source.url }))}>
        <Icon name="image" size={11} />
        {alt || new URL(source.url).hostname}
      </a>
    );
  }
  return (
    <span className={s.imageRef} title={`Can’t show ${src}`}>
      <Icon name="image" size={11} />
      {alt || 'image'}
    </span>
  );
}

/** Whether the text is still being written (read by graph blocks; a context, so renderers stay put). */
const LiveText = createContext(false);
/** Every local image in the message, so the lightbox steps from one to the next (a context, as above). */
const MessageImages = createContext<readonly ChatImage[]>([]);

function MessageImage({ src, alt, local }: { src: string; alt: string; local: boolean }) {
  return <MdImage src={src} alt={alt} all={useContext(MessageImages)} local={local} />;
}

/** A graph block in a message (its own component, so it stays mounted while the text grows). */
function MessageGraph({ code, localImages }: { code: string; localImages: boolean }) {
  const live = useContext(LiveText);
  return <GraphBlock code={code} live={live} localImages={localImages} />;
}

/** A live element in a message (a table, chart…): its source runs only for your own Claude's. */
function MessageView({ code, type, local }: { code: string; type: NonNullable<ReturnType<typeof viewFenceType>>; local: boolean }) {
  const live = useContext(LiveText);
  return <ViewBlock code={code} type={type} live={live} local={local} />;
}

/** A live preview (Settings › Experimental): built only for your own Claude's, once the text is all there. */
// Loaded only when a message has a preview: with the experiment off, none of it is ever loaded.
const PreviewBlock = lazy(() => import('../components/preview/PreviewBlock.js').then((m) => ({ default: m.PreviewBlock })));

function MessagePreview({ code, local }: { code: string; local: boolean }) {
  const live = useContext(LiveText);
  // Off (or a friend's, or no worktree here): a small card, and nothing of the previews loads.
  if (!usePreviewHere(local).draws) return <PreviewNotice code={code} local={local} />;
  return (
    <Suspense fallback={null}>
      <PreviewBlock code={code} live={live} local={local} />
    </Suspense>
  );
}

/**
 * A fenced block that's really something else (shared/render/rich-fence.ts): a file tree, JSON, a
 * terminal session, math, or a mermaid diagram drawn as our own graph or view. Otherwise code.
 */
function MessageFence({ code, lang, localImages }: { code: string; lang: string | undefined; localImages: boolean }) {
  const { ui } = useBeluga();
  const live = useContext(LiveText);
  const fence = useRichFence(lang, code);
  if (fence?.kind === 'math') return <MathTex tex={fence.tex} display />;
  if (fence?.kind === 'mermaid') return fence.block.kind === 'graph' ? <GraphBlock code={fence.block.text} live={live} localImages={localImages} /> : <ViewBlock code={fence.block.text} type="any" live={live} local={localImages} />;
  if (fence) return <RichBlock fence={fence} code={code} lang={lang} onQuote={(text) => quoteInBox(ui, text)} />;
  // A kind of diagram we don't draw ourselves: Mermaid draws it, once it's all there.
  if (lang === 'mermaid' && !live) return <Diagram code={code} />;
  return <Code code={code} {...(lang ? { lang } : {})} />;
}

type HastNode = { type: string; tagName?: string; value?: string; children?: HastNode[] };

/** How many images a paragraph holds when it's nothing but images (0 otherwise). */
function imagesOnly(node: HastNode | undefined): number {
  const kids = node?.children ?? [];
  const images = kids.filter((k) => k.type === 'element' && k.tagName === 'img').length;
  const rest = kids.filter((k) => !(k.type === 'element' && k.tagName === 'img') && !(k.type === 'text' && !k.value?.trim()) && !(k.type === 'element' && k.tagName === 'br'));
  return rest.length ? 0 : images;
}

const keepUrl = (u: string): string => u;

const REMARK = [remarkGfm, remarkMath];
const NO_REHYPE: [] = [];

/**
 * Math (after prepareMath) set aside while paths, mentions and task keys are linked, so `$a/b.c$`
 * stays math: each `$…$` and each line of a `$$` block becomes a placeholder, put back after.
 */
function guardMath(text: string): { text: string; restore: (s: string) => string } {
  if (!text.includes('$')) return { text, restore: (s) => s };
  const kept: string[] = [];
  const hold = (m: string): string => `\uE000${kept.push(m) - 1}\uE001`;
  let fenced = false;
  let display = false;
  const out = text.split('\n').map((line) => {
    if (!display && /^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return line;
    // A `$$` that never closes stops at the paragraph's end.
    if (display && !line.trim()) display = false;
    else if (display || /^\s*\$\$/.test(line)) {
      const t = line.trim();
      // A block opens on "$$" and closes on a line ending in "$$" (or a one-line "$$…$$").
      if (!display) display = !(t.length > 2 && t.endsWith('$$'));
      else if (t.endsWith('$$')) display = false;
      return hold(line);
    }
    if (!line.includes('$')) return line;
    return splitInlineMath(line)
      .map((p) => ('tex' in p ? hold(`$${p.tex}$`) : p.text))
      .join('');
  });
  return { text: out.join('\n'), restore: (s) => (kept.length ? s.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => kept[Number(i)] ?? '') : s) };
}

/** The board's keys as one string, worked out once per board (not for every message on every event). */
const keysOf = new WeakMap<readonly { readonly key: string }[], string>();
function boardKeys(issues: readonly { readonly key: string }[]): string {
  let keys = keysOf.get(issues);
  if (keys === undefined) keysOf.set(issues, (keys = issues.map((i) => i.key).join(' ')));
  return keys;
}

/** Every worktree's id, as one string (made once per projects list), as boardKeys. */
type ProjectList = readonly { readonly workspaces: readonly { readonly id: string; readonly kind: string }[] }[];
const idsOf = new WeakMap<ProjectList, string>();
function worktreeIds(projects: ProjectList): string {
  let ids = idsOf.get(projects);
  if (ids === undefined) idsOf.set(projects, (ids = projects.flatMap((p) => p.workspaces.filter((w) => w.kind === 'worktree').map((w) => w.id)).join(' ')));
  return ids;
}

/**
 * `localImages`: pictures named by a path on this Mac are shown (your own messages and your own
 * Claude's only; anyone else's stay a chip). `mentions`: draw "@mia", "@bob-api", "@src/auth.ts"…
 * as pills when they name someone or something here. `live`: the text is still being written (a
 * graph block that isn't finished yet says it's being drawn instead of failing). `tasks`: a bare
 * key your board has ("BLG-72") is a small task chip, and so is a pasted "worktree:wt-…" you have
 * (your own and your own Claude's words only: someone else's key may be on their board). `typed`: a person's own words, so the lines they broke
 * and the blank lines they left show as typed (typed-lines.ts), not folded as Markdown would.
 * `html`: text written on GitHub (an issue, a PR comment), so the HTML in it is drawn as GitHub
 * draws it, cut down to what GitHub allows (it also drops the links paths, mentions and task keys
 * would add, so it's for GitHub's words only).
 */
export const Markdown = memo(function Markdown({ text, paths = false, localImages = false, mentions, live = false, tasks = false, typed = false, html = false }: { text: string; paths?: boolean; localImages?: boolean; mentions?: MentionWorld; live?: boolean; tasks?: boolean; typed?: boolean; html?: boolean }) {
  const actions = useActions();
  // The board's keys as one string, so a task changing doesn't draw every message again.
  const keys = useApp((st) => (tasks ? boardKeys(st.board.issues) : ''));
  const worktrees = useApp((st) => (tasks ? worktreeIds(st.projects) : ''));
  // Paths relative to a worktree link only where there's one on screen to open them in.
  const inWorktree = useApp((st) => paths && st.view.kind === 'workspace');
  const source = useMemo(() => {
    // Math first (prices stay words), then set aside so the links below leave it alone.
    const math = guardMath(prepareMath(typed ? keepBlankLines(text) : text));
    // A pasted worktree link in ticks first (its chip), then mentions, paths and task keys: each leaves the code and links before it alone.
    const known = new Set(worktrees.split(' '));
    const withRefs = worktrees ? codeWorktreeRefs(math.text, (id) => known.has(id)) : math.text;
    const withMentions = mentions ? linkMentions(withRefs, mentions) : withRefs;
    const withPaths = paths ? linkPaths(withMentions, { relative: inWorktree }) : withMentions;
    const board = new Set(keys.split(' '));
    return math.restore(keys ? linkTaskKeys(withPaths, (k) => board.has(k)) : withPaths);
  }, [text, keys, worktrees, mentions, paths, inWorktree, typed]);
  // Every local image in the message, so the lightbox steps from one to the next.
  const images = useMemo(() => (localImages ? messageImages(text) : []), [text, localImages]);
  // The same renderers from one render to the next: a new one would remount what it drew (a graph
  // would lay itself out again on every streamed word).
  const components = useMemo<Components>(() => ({
    img: ({ src, alt }) => <MessageImage src={typeof src === 'string' ? src : ''} alt={alt ?? ''} local={localImages} />,
    // A paragraph of nothing but images: a row of them (several get smaller, side by side).
    p: ({ node, children }) => {
      const count = imagesOnly(node as HastNode | undefined);
      return count ? (
        <div className={s.mdImages} data-count={count > 1 ? 'many' : 'one'}>
          {children}
        </div>
      ) : (
        <p>{children}</p>
      );
    },
    a: ({ href = '', children }) => {
      const mention = parseMentionHref(href);
      if (mention) return <MentionPill mention={mention} />;
      // A bare task key (shared/task-refs.ts linkTaskKeys): the board's small chip.
      if (href.startsWith(TASK_LINK_SCHEME)) return <TaskKeyChip taskKey={href.slice(TASK_LINK_SCHEME.length)} />;
      // An image in the words: the chip the message box showed, a link that opens it full size.
      const image = parseAttachmentHref(href);
      if (image) {
        const label = /image \d+/.exec(String(children))?.[0] ?? 'image';
        return <ImageChip href={href} label={label} title={`Open ${label}`} onClick={(e) => (e.preventDefault(), openLightbox([{ href, ...image, label }]))} />;
      }
      // A file or folder named in the words (shared/render/path-refs.ts): opens it, right-click for more.
      const path = parsePathHref(href);
      if (path) return <PathLink pathRef={path}>{children}</PathLink>;
      return (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            actions.openLink(targetOf(href));
          }}
        >
          {children}
        </a>
      );
    },
    code: ({ node, className, children }) => {
      const lang = /language-([\w-]+)/.exec(className ?? '')?.[1];
      // Its text from the tree: HTML's code can wrap its words in spans.
      const code = (node ? hastText(node) : String(children)).replace(/\n$/, '');
      // Math (remark-math): `$…$` in a line, a `$$` block on its own.
      if (className?.includes('math-inline')) return <MathTex tex={code} display={false} />;
      if (className?.includes('math-display')) return <MathTex tex={code} display />;
      // Inline code that stands for something (a color, a status, keys…) is drawn as it (views/inline-model.ts).
      if (!className && !code.includes('\n')) return <InlineCode text={code} fallback={<code className={s.inlineCode}>{children}</code>} />;
      // A diagram Claude drew (docs/graphs.md): only data, drawn with the window's own pieces.
      if (isGraphFence(lang)) return <MessageGraph code={code} localImages={localImages} />;
      // Board tasks Claude shows (shared/task-refs.ts): live cards that open the task.
      if (lang === TASKS_FENCE) return <TaskCards code={code} />;
      // Lines of the repository Claude points at (shared/code-ref.ts): read from the worktree, marked, openable.
      if (lang === CODE_FENCE) return <CodeRefBlock code={code} />;
      // The worktree's PR comments, when you asked what reviewers said (shared/pr-comments-ref.ts): read-only, the PR page answers them.
      if (lang === PR_COMMENTS_FENCE) return <PrCommentsBlock code={code} />;
      // A component or page drawn live (shared/preview/ref.ts), when Live previews are on.
      if (lang === PREVIEW_FENCE) return <MessagePreview code={code} local={localImages} />;
      // Tables, charts, stats, code and colors (docs/views.md): data, drawn live.
      const view = viewFenceType(lang);
      if (view) return <MessageView code={code} type={view} local={localImages} />;
      // A tree, JSON, a terminal, math or mermaid (shared/render/rich-fence.ts), else code.
      return <MessageFence code={code} lang={lang} localImages={localImages} />;
    },
    pre: ({ children }) => <>{children}</>,
    // A plain table (the kind Claude Code prints) sorts, searches and charts like a view; one with links stays as written.
    table: ({ node, children }) => (
      <MarkdownTable
        node={node}
        fallback={
          <div className={s.tableWrap}>
            <table>{children}</table>
          </div>
        }
      />
    ),
  }), [actions, localImages]);
  return (
    <LiveText.Provider value={live}>
      <MessageImages.Provider value={images}>
      <div className={`${s.markdown} ${typed ? s.typed : ''} selectable`} data-md>
        <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={html ? GITHUB_REHYPE : NO_REHYPE} remarkRehypeOptions={html ? TO_HTML : undefined} components={components} urlTransform={keepUrl}>
          {source}
        </ReactMarkdown>
      </div>
      </MessageImages.Provider>
    </LiveText.Provider>
  );
});
