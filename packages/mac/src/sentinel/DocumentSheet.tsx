import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { type DocumentLook, type DocumentRead, documentLook, documentMime, kindWords, quietHtml, sizeWords } from '@beluga/core/sentinel/columns.js';
import { Markdown } from '../chat/Markdown.js';
import { FormSheet } from '../components/FormSheet.js';
import { Icon } from '../components/Icon.js';
import { Button } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApi } from '../lib/beluga.js';
import { ago } from '../tasks/tasks-model.js';
import { jsonFence } from './numbers-model.js';
import { useSentinelActions } from './use-sentinel.js';
import n from './numbers.module.css';
import { fileManager, revealLabel } from '../lib/os-words.js';

type Read = DocumentRead & { readonly bucket?: string; readonly path?: string };

/** Kinds shown in a tall sheet: a preview you read or watch, not a few lines. */
const TALL: ReadonlySet<DocumentLook> = new Set(['html', 'image', 'pdf', 'video']);

// PDF.js, loaded with the first PDF opened (the web view leaves a PDF in an iframe blank).
const PdfView = lazy(() => import('../views/reader/PdfView.js').then((m) => ({ default: m.PdfView })));

/**
 * A kept table's document or storage object (BLG-381), in Beluga: a page with nothing allowed to run
 * or load (its policy first, and a sandbox with nothing allowed), Markdown, JSON as a tree, text, a
 * picture, a PDF, a video or a sound. A kind Beluga can't show (a zip, a Word file), or one too big,
 * says what it is, how big, and where it's from, with Open in Default App and Show in Finder. A
 * storage object is fetched now through a link signed for a minute; a copy is saved only to open it.
 */
export function DocumentSheet({ source, sentinelId, metric, column, name, close }: { source: 'kept' | 'storage' | 'run'; sentinelId: string; metric: string; column: string; name: string; close: () => void }) {
  const api = useApi();
  const a = useSentinelActions();
  const actions = useActions();
  const [doc, setDoc] = useState<Read>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    // A run's file: `metric` is its run (BLG-392).
    const read: Promise<Read> = source === 'storage' ? api.sentinel.storageDocument(sentinelId, metric, column, name) : source === 'run' ? api.sentinel.runFile(metric, name) : api.sentinel.document(sentinelId, metric, column, name);
    read.then(
      (d) => alive && setDoc(d),
      (err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      alive = false;
    };
  }, [source, sentinelId, metric, column, name]);
  const title = doc?.name ?? name.split('/').pop() ?? name;
  const look = doc && !doc.tooBig ? documentLook(doc.mime) : undefined;
  // A video or a sound from its bytes, while the sheet is open.
  const blob = useMemo(() => (doc?.base64 && (look === 'video' || look === 'audio') ? URL.createObjectURL(new Blob([Uint8Array.from(atob(doc.base64), (c) => c.charCodeAt(0))], { type: doc.mime })) : undefined), [doc, look]);
  useEffect(() => () => (blob ? URL.revokeObjectURL(blob) : undefined), [blob]);
  const open = (how: 'open' | 'reveal'): void => void a.act(() => (source === 'storage' ? api.sentinel.storageOpen(sentinelId, metric, column, name, how) : source === 'run' ? api.sentinel.runFileOpen(metric, name, how) : api.sentinel.documentOpen(sentinelId, metric, column, name, how)));
  const inBrowser = (): void =>
    void a.act(async () => {
      const { url } = await api.sentinel.signStorage(sentinelId, metric, column, name);
      actions.openLink({ kind: 'url', url });
    });
  const shown = doc ? body(doc, look, title, blob) : undefined;
  // A page, a picture, a PDF or a video gets most of the window; while it loads, its name says which.
  const tall = !error && (doc ? shown !== undefined && TALL.has(look ?? 'other') : TALL.has(documentLook(documentMime(name))));
  const buttons = (
    <>
      <Button size="small" icon="external" onClick={() => open('open')}>
        Open in Default App
      </Button>
      <Button size="small" icon="folder" onClick={() => open('reveal')}>
        {revealLabel()}
      </Button>
    </>
  );
  return (
    <FormSheet title={title} icon="file" submitLabel="Close" hideSubmit cancelLabel="Close" width={tall ? 1080 : 820} tall={tall} onSubmit={close} onCancel={close} footer={shown && doc ? <span className={n.docButtons}>{buttons}</span> : null}>
      <div className={n.docView} data-look={look ?? (doc ? 'info' : 'wait')} data-tall={tall || undefined}>
        {error ? (
          <div className={n.docInfo}>
            <p className={n.docNote}>{error}</p>
            {source === 'storage' ? (
              <span className={n.docButtons}>
                <Button size="small" icon="globe" onClick={inBrowser}>
                  Open Link in Browser
                </Button>
              </span>
            ) : null}
          </div>
        ) : !doc ? (
          <p className={n.docNote}>{source === 'storage' ? 'Fetching it from Storage…' : 'Loading…'}</p>
        ) : (
          (shown ?? (
            <div className={n.docInfo}>
              <span className={n.docIcon} aria-hidden="true">
                <Icon name="file" size={22} />
              </span>
              <dl className={n.docMeta}>
                <dt>Kind</dt>
                <dd>{kindWords(doc.name, doc.mime)}</dd>
                <dt>Size</dt>
                <dd>{sizeWords(doc.size)}</dd>
                {doc.bucket ? (
                  <>
                    <dt>In Storage</dt>
                    <dd className={n.docPath}>
                      {doc.bucket}/{doc.path}
                    </dd>
                  </>
                ) : null}
                {doc.at ? (
                  <>
                    <dt>{doc.bucket ? 'Listed' : 'Kept'}</dt>
                    <dd>{ago(doc.at)}</dd>
                  </>
                ) : null}
              </dl>
              <p className={n.docNote}>{doc.tooBig ? `It’s too big to show here: open it in its app, or find it in ${fileManager()}.` : `Beluga can’t show a ${kindWords(doc.name, doc.mime).replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())} here: open it in its app, or find it in ${fileManager()}.`}</p>
              <span className={n.docButtons}>{buttons}</span>
            </div>
          ))
        )}
        {doc?.cut ? <p className={n.docNote}>Only the start is shown here: open it to see the rest.</p> : null}
      </div>
    </FormSheet>
  );
}

/** The document drawn, when Beluga shows its kind (nothing: say what it is instead). */
function body(doc: Read, look: ReturnType<typeof documentLook> | undefined, title: string, blob: string | undefined): React.ReactNode | undefined {
  const text = doc.text;
  switch (look) {
    case 'html':
      return text !== undefined ? <iframe className={n.docFrame} title={title} sandbox="" srcDoc={quietHtml(text)} referrerPolicy="no-referrer" /> : undefined;
    case 'markdown':
      return text !== undefined ? (
        <div className={n.docPage}>
          <Markdown text={text} />
        </div>
      ) : undefined;
    case 'json':
      return text !== undefined ? (
        <div className={n.docPage}>
          <Markdown text={jsonFence(text)} />
        </div>
      ) : undefined;
    case 'text':
      return text !== undefined ? <pre className={n.docText}>{text}</pre> : undefined;
    case 'image':
      return <img className={n.docImage} alt={title} src={doc.base64 ? `data:${doc.mime};base64,${doc.base64}` : `data:${doc.mime};charset=utf-8,${encodeURIComponent(text ?? '')}`} />;
    case 'pdf':
      return doc.base64 ? (
        <div className={n.docPdf}>
          <Suspense fallback={<p className={n.docNote}>Opening…</p>}>
            <PdfView data={doc.base64} controls />
          </Suspense>
        </div>
      ) : undefined;
    case 'video':
      return blob ? <video className={n.docImage} src={blob} controls /> : undefined;
    case 'audio':
      return blob ? <audio className={n.docAudio} src={blob} controls /> : undefined;
    default:
      return undefined;
  }
}
