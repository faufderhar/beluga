import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { MAX_STREAM_BYTES } from '@beluga/shared/text-range.js';
import type { ViewerState } from '@beluga/core/store.js';
import { formatBytes } from '@beluga/shared/format.js';
import { Icon } from '../../components/Icon.js';
import { Button, Empty, EmptyActions, IconButton, cx } from '../../components/ui.js';
import { CodeLines } from '../../components/markdown/CodeLines.js';
import { type DocNav, type DocVariant, MarkdownDoc } from '../../components/markdown/MarkdownDoc.js';
import { useImageUrl } from '../../components/markdown/MdImage.js';
import { VideoPlayer } from '../../components/VideoPlayer.js';
import { MAX_FILE_BYTES } from '@beluga/protocol.js';
import { fileKey } from '@beluga/core/store.js';
import { useApi, useApp } from '../../lib/beluga.js';
import { Bitmap } from '../FilesView.js';
import { isImageFile, isVideoFile } from '../../components/markdown/md-paths.js';
import { BINARY_TEXT, HTML_SANDBOX, LARGE_MARKDOWN, prettyJson, previewVersion, type ReaderMode, isHtmlFile, isMarkdownFile, isPdfFile, langOf } from './reader-model.js';
import { PdfView } from './PdfView.js';
import { usePinchZoom } from '../../components/usePinchZoom.js';
import { useDecoded } from '../../components/use-decoded.js';
import { useEditSession } from './edit-store.js';
import { FileEditor } from './FileEditor.js';
import { doneRevealing, scrollToLine, useReveal } from './reveal.js';
import { peekFirst, useRest } from './streamed.js';
import r from './reader.module.css';
import { useFirstPaintMark } from '../../lib/first-paint.js';

/**
 * One open file, read the right way: Markdown formatted (or as source), code with line numbers and
 * colors, images fitted to the window with zoom. The same in the focus view, the panel's preview
 * and the Files view; each brings its own header.
 */

function Notice({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className={r.notice} role="note">
      <Icon name="info" size={13} />
      <span className={r.noticeText}>{children}</span>
      {action}
    </div>
  );
}

/** Asks for more of a big file as the reader nears the end of what it has (BLG-791). */
function MoreWhenNear({ onNear }: { onNear: () => void }) {
  const at = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = at.current;
    if (!el) return;
    // A new onNear after each piece: still in sight, the next one is asked for.
    const seen = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onNear(), { rootMargin: '1500px 0px' });
    seen.observe(el);
    return () => seen.disconnect();
  }, [onNear]);
  return <div ref={at} className={r.more} aria-hidden />;
}

const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

/**
 * An image as wide as the space it has (never blown up past its own size), so a tall one scrolls;
 * zoom in and out, or double-click for actual size. The original file is shown (sharp at any
 * zoom), not the small preview Beluga decoded for the terminal.
 */
function ImageView({ viewer, controls, version }: { viewer: ViewerState; controls: boolean; version?: string | number | undefined }) {
  const { url, error } = useImageUrl({ owner: viewer.owner, share: viewer.share, path: viewer.path }, version);
  // Written again (a live screenshot): the new picture is decoded first, the old one shown meanwhile.
  const pic = useDecoded(url);
  const natural = pic && pic.w > 0 ? { w: pic.w, h: pic.h } : undefined;
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const stage = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  // From "fit", zooming goes to the next step past the size it's fitted at.
  const fitted = (): number => {
    const el = stage.current;
    return el && natural ? Math.min(1, (el.clientWidth - 56) / natural.w) : 1;
  };
  // Two fingers on the trackpad zoom it too (anywhere it's shown: the reader, the panel, Changes,
  // Scratch): the picture is scaled with a transform while they move, and laid out once they stop.
  usePinchZoom(stage, zoom === 'fit' ? fitted() : zoom, setZoom, { live: picture });
  const step = (dir: 1 | -1): void => {
    const now = zoom === 'fit' ? fitted() : zoom;
    const next = dir > 0 ? ZOOMS.find((z) => z > now + 0.001) : [...ZOOMS].reverse().find((z) => z < now - 0.001);
    if (next) setZoom(next);
  };
  const onDouble = (e: MouseEvent): void => {
    e.preventDefault();
    setZoom(zoom === 'fit' ? 1 : 'fit');
  };
  if (error && !viewer.image) return <Empty icon="alert" title="Can’t show this picture" detail={error} />;
  const sized = zoom !== 'fit' && natural ? { width: natural.w * zoom, height: natural.h * zoom, maxWidth: 'none' } : undefined;
  return (
    <div className={r.imageView}>
      <div ref={stage} className={cx(r.stage, zoom !== 'fit' && r.stageZoom)} onDoubleClick={onDouble}>
        {pic ? (
          <img ref={picture} className={r.picture} src={pic.url} alt={viewer.path} style={sized} draggable={false} />
        ) : viewer.image ? (
          <Bitmap image={viewer.image} />
        ) : null}
      </div>
      {controls ? (
        <div className={r.zoomBar} role="toolbar" aria-label="Zoom">
          <IconButton size="small" icon="minus" label="Zoom out" onClick={() => step(-1)} />
          <button type="button" className={r.zoomValue} onClick={() => setZoom(zoom === 'fit' ? 1 : 'fit')} aria-label={zoom === 'fit' ? 'Actual size' : 'Fit to window'}>
            {zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`}
          </button>
          <IconButton size="small" icon="plus" label="Zoom in" onClick={() => step(1)} />
          {natural ? <span className={r.zoomSize}>{`${natural.w} × ${natural.h}`}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/** A video, played from its bytes (read like a picture, up to MAX_DOC_VIDEO_BYTES). */
function VideoFile({ viewer, version, fallback }: { viewer: ViewerState; version?: string | number | undefined; fallback?: ReactNode }) {
  const { url, error } = useImageUrl({ owner: viewer.owner, share: viewer.share, path: viewer.path }, version);
  if (error) return <Empty icon="play" title="Can’t play this video here" detail={/too large/i.test(error) ? 'It’s too big to play here (up to 64 MB).' : error} action={fallback ? <EmptyActions>{fallback}</EmptyActions> : undefined} />;
  if (!url) return <div className={r.opening}>Opening…</div>;
  return <VideoPlayer url={url} name={viewer.path} fallback={fallback} />;
}

export interface FileContentProps {
  readonly viewer: ViewerState;
  readonly variant: DocVariant;
  readonly mode: ReaderMode;
  readonly onMode: (mode: ReaderMode) => void;
  /** Long lines wrap (code and Markdown source). */
  readonly wrap: boolean;
  /** Where the file is on this Mac, when it's yours (offers Open in Editor). */
  readonly onOpenInEditor?: (() => void) | undefined;
  readonly onSaveCopy?: (() => void) | undefined;
  readonly nav?: Partial<DocNav>;
  /** Changes when the file may have: a picture, PDF or video is read again then (without one, when Beluga sees it written). */
  readonly version?: unknown;
  /** You may edit it here (Edit in the header starts it): your own workspace's file, in the panel or full size. */
  readonly editable?: boolean;
}

/** The file itself, under whatever header the place showing it has. */
export function FileContent({ viewer, variant, mode, onMode, wrap, onOpenInEditor, onSaveCopy, nav, version, editable = false }: FileContentProps) {
  // A big file opened by its first piece isn't all here, so it isn't edited here.
  const editing = useEditSession(editable && viewer.next === undefined ? viewer : undefined);
  const rest = useRest(useApi(), viewer);
  // Still opening: the first piece read ahead under the pointer shows meanwhile.
  const ahead = viewer.loading && !viewer.content && !viewer.error ? peekFirst(viewer) : undefined;
  const content = (ahead?.binary ? '' : (ahead?.content ?? viewer.content)) + rest.text;
  useFirstPaintMark('beluga:file-shown', viewer.path, content.length > 0 && !viewer.error);
  const reveal = useReveal(viewer);
  const box = useRef<HTMLDivElement>(null);
  const markdown = isMarkdownFile(viewer.path);
  const html = isHtmlFile(viewer.path);
  const written = useApp((st) => st.written[fileKey(viewer)]);
  const fresh = previewVersion(version, written);
  // A search result opened it at a line: the source, scrolled there (once it's drawn).
  useEffect(() => {
    if (!reveal || viewer.loading || !content) return;
    if ((markdown || html) && mode === 'rendered' && !editing) return onMode('source');
    const frame = requestAnimationFrame(() => {
      if (box.current && scrollToLine(box.current, reveal.line, r.lineFlash!)) doneRevealing(viewer);
    });
    return () => cancelAnimationFrame(frame);
  }, [reveal?.seq, viewer.path, viewer.loading, content.length, mode, Boolean(editing)]);
  // PDFs and pictures are read as themselves (their bytes), whatever the text read made of them.
  if (isPdfFile(viewer.path)) return <PdfView at={{ owner: viewer.owner, share: viewer.share, path: viewer.path }} controls={variant !== 'panel'} version={fresh ?? version} />;
  if (isVideoFile(viewer.path)) {
    const out = onOpenInEditor ? (
      <Button size="small" variant="quiet" icon="external" onClick={onOpenInEditor}>
        Open in Editor
      </Button>
    ) : onSaveCopy ? (
      <Button size="small" variant="quiet" icon="download" onClick={onSaveCopy}>
        Save a Copy…
      </Button>
    ) : undefined;
    return <VideoFile viewer={viewer} fallback={out} version={fresh} />;
  }
  if (viewer.image || (isImageFile(viewer.path) && !viewer.error)) return <ImageView viewer={viewer} controls={variant !== 'panel'} version={fresh} />;
  if (viewer.loading && !content) return <div className={r.opening}>Opening…</div>;
  if (viewer.error) return <Empty icon="alert" title="Can’t open this file" detail={viewer.error} />;
  const escape = onOpenInEditor ? (
    <Button size="small" variant="quiet" icon="external" onClick={onOpenInEditor}>
      Open in Editor
    </Button>
  ) : onSaveCopy ? (
    <Button size="small" variant="quiet" icon="download" onClick={onSaveCopy}>
      Save a Copy…
    </Button>
  ) : undefined;
  if (viewer.content === BINARY_TEXT) {
    return <Empty icon="file" title="No preview for this kind of file" detail="It isn’t text, a picture, a PDF or a video. Open it with its app instead." action={escape ? <EmptyActions>{escape}</EmptyActions> : undefined} />;
  }
  const large = markdown && content.length > LARGE_MARKDOWN;
  const json = mode === 'rendered' ? prettyJson(viewer.path, content) : undefined;
  return (
    <div ref={box} className={cx(r.content, r[`v_${variant}`])}>
      {viewer.truncated || rest.capped ? <Notice action={escape}>Only the first {formatBytes(rest.capped ? MAX_STREAM_BYTES : MAX_FILE_BYTES)} of this file is shown.</Notice> : null}
      {large && mode === 'source' ? (
        <Notice
          action={
            <Button size="small" variant="quiet" onClick={() => onMode('rendered')}>
              Format It Anyway
            </Button>
          }
        >
          This file is large ({formatBytes(viewer.total ?? content.length)}), so it opens as source.
        </Notice>
      ) : null}
      {editing ? (
        <div className={r.codeFile}>
          <FileEditor session={editing} lang={markdown ? 'markdown' : langOf(viewer.path)} variant={variant} />
        </div>
      ) : html && mode === 'rendered' ? (
        <iframe className={r.html} title={viewer.path.split('/').pop() ?? viewer.path} sandbox={HTML_SANDBOX} srcDoc={content} referrerPolicy="no-referrer" />
      ) : markdown && mode === 'rendered' ? (
        <MarkdownDoc text={content} at={viewer} variant={variant} {...(nav ? { nav } : {})} />
      ) : (
        <div className={r.codeFile}>
          <CodeLines text={json ?? content} lang={markdown ? 'markdown' : langOf(viewer.path)} numbers wrap={wrap || variant === 'panel'} />
        </div>
      )}
      {rest.more && !editing ? <MoreWhenNear onNear={rest.more} /> : null}
      {rest.error ? <Notice>The rest of this file couldn’t be read: {rest.error}</Notice> : null}
    </div>
  );
}
