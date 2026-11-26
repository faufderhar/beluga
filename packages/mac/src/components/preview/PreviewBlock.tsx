import { useEffect, useMemo, useRef, useState } from 'react';
import { type PreviewRef, type PreviewSize, PREVIEW_SIZES, SIZE_WIDTH, parsePreviewRef, previewTitle } from '@beluga/shared/preview/ref.js';
import { quoteInBox } from '../../chat/message-menu.js';
import { copyText } from '../../lib/copy.js';
import { toast, useApi, useApp, useBeluga } from '../../lib/beluga.js';
import { openExternal } from '../../lib/system.js';
import { useWindowActive } from '../../lib/window-active.js';
import { Icon } from '../Icon.js';
import { ActionsContext, ActionsDropdown, type ActionItem } from '../SpecMenu.js';
import { Button, IconButton, Segmented, Tip, cx } from '../ui.js';
import { PropControls } from './PropControls.js';
import { PreviewNotice, usePreviewHere } from './PreviewNotice.js';
import { AuditPanel, EventsStrip, ProblemCard } from './PreviewParts.js';
import { type ComponentWidth, COMPONENT_WIDTHS, askToFix, floatsOverFrame, frameHeight, pageScale, propsForAgent, variantField } from './preview-model.js';
import { PIN_STATES, type PinState, usePreview } from './use-preview.js';
import s from './preview.module.css';

/**
 * A live preview (Settings › Experimental › Live previews): a component or page of the worktree,
 * built on this computer (src/preview) and drawn in a frame of its own, beside the props it was
 * given, which you can change. It's built only once it scrolls into view, follows the file as it
 * changes, and says what's wrong in plain words when it can't draw (the details go to your agent).
 */

/** How tall a page is shown (a component's frame takes its own height). */
const PAGE_HEIGHT = { regular: 420, expanded: 720 } as const;
const SIZE_LABEL: Readonly<Record<PreviewSize, string>> = { phone: 'Phone', tablet: 'Tablet', desktop: 'Desktop' };
/** Built a little before it scrolls into view, so it's there when you get to it. */
const AHEAD = '240px';
/** A frame this far off screen is unloaded (its memory, its connection), and loads again on the way back. */
const NEAR = '1200px';
/** Away from Beluga this long, frames are unloaded too (their builds and watchers let go); back, they draw again. */
const AWAY_MS = 2 * 60_000;

/** You've been away from Beluga's window a while (a moment away changes nothing). */
function useAwayLong(): boolean {
  const looking = useWindowActive();
  const [away, setAway] = useState(false);
  useEffect(() => {
    if (looking) return setAway(false);
    const t = setTimeout(() => setAway(true), AWAY_MS);
    return () => clearTimeout(t);
  }, [looking]);
  return away;
}


/**
 * A ```beluga-preview block in a message that can draw here (Markdown.tsx checks with
 * usePreviewHere first, and shows PreviewNotice otherwise). `live`: still being written.
 */
export function PreviewBlock({ code, live, local }: { code: string; live: boolean; local: boolean }) {
  const ref = useMemo(() => parsePreviewRef(code), [code]);
  const { draws, wsId } = usePreviewHere(local);
  if (!ref) return live ? <Waiting text="Getting the preview ready…" /> : <PreviewNotice code={code} local={local} />;
  if (!draws || !wsId) return <PreviewNotice code={code} local={local} />;
  if (live) return <Waiting text={`Getting ${previewTitle(ref)} ready…`} />;
  return <PreviewView ref_={ref} wsId={wsId} />;
}

function Waiting({ text }: { text: string }) {
  return (
    <figure className={cx(s.preview, s.waiting)}>
      <div className={s.skeleton}>
        <span className={s.skeletonPulse} />
        {text}
      </div>
    </figure>
  );
}

/** Whether the element is (or is about to be) within `margin` of the screen. */
function useOnScreen(el: React.RefObject<HTMLElement | null>, margin: string): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') return setOn(true);
    const io = new IntersectionObserver((entries) => setOn(entries.some((e) => e.isIntersecting)), { rootMargin: margin });
    io.observe(node);
    return () => io.disconnect();
  }, [el, margin]);
  return on;
}

/** It came near the screen once: previews are built only then (and kept). */
function useSeen(el: React.RefObject<HTMLElement | null>): boolean {
  const near = useOnScreen(el, AHEAD);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (near) setSeen(true);
  }, [near]);
  return seen;
}

/** The box's width, kept up to date (a page is scaled to it). */
function useWidth(el: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = el.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(Math.round(entry.contentRect.width)));
    ro.observe(node);
    return () => ro.disconnect();
  }, [el]);
  return width;
}

/** The preview itself: the frame, its header, its props. Used in chat and in Files. */
export function PreviewView({ ref_: ref, wsId, embedded = false }: { ref_: PreviewRef; wsId: string; embedded?: boolean }) {
  const api = useApi();
  const { client, ui } = useBeluga();
  const box = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const seen = useSeen(box);
  const near = useOnScreen(box, NEAR);
  const stageWidth = useWidth(stage);
  const target = ref.target;
  const page = target.kind !== 'component';
  // Far off screen, or away from Beluga a while, the frame is unloaded (Files' own preview stays while you look).
  const away = useAwayLong();
  const framed = (near || embedded) && !away;
  const [pick, setPick] = useState<string>();
  const p = usePreview({ wsId, ref, pick, seen, framed });
  const [showProps, setShowProps] = useState(embedded);
  const [expanded, setExpanded] = useState(embedded);
  const [size, setSize] = useState<PreviewSize>(ref.size ?? 'desktop');
  const [width, setWidth] = useState<ComponentWidth>(ref.size ?? 'fit');

  const title = previewTitle(ref);
  const name = p.ok?.component?.name ?? title;
  const fields = p.ok?.component?.props ?? [];
  const exports = p.ok?.component?.exports ?? [];
  const variantOf = useMemo(() => variantField(fields), [fields]);
  const file = target.kind === 'url' ? undefined : target.file;
  const goTo = (): void => void (file && api.workbench.openCode(wsId, file));
  const say = (text: string, level: 'success' | 'warn' = 'success'): void => toast(client, text, level);
  const ask = (): void => void (p.problem && quoteInBox(ui, askToFix(title, p.problem, p.values)));
  const tools = !page && p.drawn && !p.problem;
  const savePicture = (): void =>
    void p.picture().then((out) => (out.path ? say(`Saved a picture to ${out.path}`) : say(`Couldn’t save a picture: ${out.failed}`, 'warn')));
  const togglePin = (state: PinState): void => p.setPinned(p.pinned.includes(state) ? p.pinned.filter((x) => x !== state) : [...p.pinned, state]);

  // ••• and right-click: everything beyond the frame and its props.
  const items: ActionItem[] = [
    ...(file ? [{ label: 'Open in Editor', icon: 'external' as const, onSelect: goTo }] : []),
    ...(target.kind === 'url' ? [{ label: 'Open in Browser', icon: 'globe' as const, onSelect: () => void openExternal(target.url) }] : []),
    { label: 'Draw Again', icon: 'refresh', onSelect: p.redraw },
    ...(!page && exports.length > 1
      ? [
          {
            label: 'Component',
            separate: true,
            onSelect: () => undefined,
            submenu: [
              ...exports.map((e) => ({ label: e, checked: !p.gallery && e === name, onSelect: () => (setPick(e), p.setGallery(false)) })),
              ...(p.ok?.gallery ? [{ label: 'All Components', separate: true, checked: p.gallery, onSelect: () => p.setGallery(!p.gallery) }] : []),
            ],
          },
        ]
      : []),
    ...(!page
      ? [
          { label: 'Width', separate: exports.length <= 1, onSelect: () => undefined, submenu: COMPONENT_WIDTHS.map((w) => ({ label: w.label, checked: width === w.value, onSelect: () => setWidth(w.value) })) },
          { label: 'Canvas', onSelect: () => undefined, submenu: [{ label: 'Light', checked: p.canvas === 'light', onSelect: () => p.setCanvas('light') }, { label: 'Dark', checked: p.canvas === 'dark', onSelect: () => p.setCanvas('dark') }] },
          { label: 'Pin State', onSelect: () => undefined, submenu: PIN_STATES.map((st) => ({ label: st[0]!.toUpperCase() + st.slice(1), checked: p.pinned.includes(st), onSelect: () => togglePin(st) })) },
          { label: 'Check Accessibility', icon: 'eye' as const, separate: true, disabled: !tools, onSelect: p.check },
          { label: 'Save as Picture', icon: 'image' as const, disabled: !tools, onSelect: savePicture },
          { label: 'Use These Props', icon: 'chat' as const, separate: true, disabled: !fields.length, onSelect: () => quoteInBox(ui, propsForAgent(name, file, p.values)) },
          { label: 'Copy Props as JSON', icon: 'copy' as const, disabled: !fields.length, onSelect: () => void copyText(JSON.stringify(p.values, null, 2)).then(() => say('Copied the props')) },
          { label: 'Reset Props', disabled: !p.touched.size, onSelect: p.reset },
        ]
      : []),
    ...(p.problem ? [{ label: p.problem.kind === 'provider' ? 'Ask Agent to Set Up' : 'Ask Agent to Fix', icon: 'chat' as const, separate: true, onSelect: ask }] : []),
  ];

  // How wide it's drawn (a page or a component at a device's width is shown smaller to fit).
  const deviceWidth = page ? SIZE_WIDTH[size] : width === 'fit' ? undefined : SIZE_WIDTH[width];
  const scale = deviceWidth ? pageScale(stageWidth, deviceWidth) : 1;
  const pageHeight = expanded ? PAGE_HEIGHT.expanded : PAGE_HEIGHT.regular;
  const contentHeight = frameHeight(p.height, expanded);
  const stageHeight = page ? (size === 'desktop' ? Math.min(pageHeight, Math.round(stageWidth * 0.62) || pageHeight) : pageHeight) : Math.round(contentHeight * scale);
  const frameStyle = page ? { width: deviceWidth, height: stageHeight / scale, transform: `scale(${scale})` } : deviceWidth ? { width: deviceWidth, height: contentHeight, transform: `scale(${scale})` } : undefined;
  const shown = p.drawn && !(p.result && !p.result.ok);
  // Nothing to draw: the stage is just the note, at its own height, in the app's colours.
  const blocked = !!p.problem && !floatsOverFrame(p.problem);
  const heading = (
    <button type="button" className={s.title} onClick={exports.length > 1 ? undefined : goTo}>
      {p.gallery ? `All components · ${file?.split('/').pop() ?? title}` : exports.length > 1 ? `${name} · ${file?.split('/').pop() ?? ''}` : title}
      {exports.length > 1 ? <Icon name="chevronDown" size={10} className={s.titleChevron} /> : null}
    </button>
  );

  return (
    <ActionsContext items={items}>
      <figure ref={box} className={cx(s.preview, embedded && s.embedded)} data-preview={title}>
        <figcaption className={s.head}>
          <Icon name="eye" size={12} className={s.headIcon} />
          {exports.length > 1 ? (
            <ActionsDropdown align="start" items={items.find((i) => i.label === 'Component')?.submenu ?? []}>
              {heading}
            </ActionsDropdown>
          ) : file ? (
            <Tip label="Open in Editor">{heading}</Tip>
          ) : (
            <span className={s.title}>{title}</span>
          )}
          {p.stale ? (
            <Tip label={`${p.stale.title}. ${p.stale.detail}`}>
              <span className={s.staleChip}>Waiting for the file</span>
            </Tip>
          ) : p.ok ? (
            <Tip label="Follows the file: it redraws when it changes">
              <span className={s.liveChip}>
                <span className={s.liveDot} />
                Live
              </span>
            </Tip>
          ) : null}
          {p.pinned.length ? <span className={s.pinChip}>{p.pinned.map((x) => x[0]!.toUpperCase() + x.slice(1)).join(', ')} pinned</span> : null}
          <span className={s.grow} />
          {page ? <Segmented size="small" label="Width" value={size} onChange={setSize} options={PREVIEW_SIZES.map((v) => ({ value: v, label: SIZE_LABEL[v] }))} /> : null}
          {!page && p.ok && fields.length && !p.gallery ? (
            <Button size="small" variant="quiet" icon="wrench" aria-pressed={showProps} className={cx(showProps && s.on)} onClick={() => setShowProps((v) => !v)}>
              Props
            </Button>
          ) : null}
          <IconButton size="small" icon="refresh" label="Draw again" onClick={p.redraw} />
          <ActionsDropdown items={items}>
            <IconButton size="small" icon="more" label="More" />
          </ActionsDropdown>
          {!embedded ? <IconButton size="small" icon="expand" label={expanded ? 'Smaller' : 'Bigger'} active={expanded} onClick={() => setExpanded((v) => !v)} /> : null}
        </figcaption>
        {ref.note ? <div className={s.note}>{ref.note}</div> : null}
        <div ref={stage} className={cx(s.stage, page && s.pageStage, p.canvas === 'dark' && s.stageDark, blocked && s.stageBlocked)} style={{ height: blocked ? undefined : stageHeight }}>
          {p.src && p.ok && framed ? (
            <iframe
              ref={p.frame}
              key={p.src.url}
              className={cx(s.frame, shown && s.frameShown)}
              title={`Preview of ${title}`}
              src={p.src.url}
              sandbox="allow-scripts allow-same-origin allow-forms"
              referrerPolicy="no-referrer"
              loading="lazy"
              onLoad={() => page && p.loaded()}
              style={{ ...frameStyle, colorScheme: p.canvas }}
            />
          ) : null}
          {p.problem ? (
            <ProblemCard problem={p.problem} touched={p.touched.size > 0} onReset={p.reset} onAsk={ask} onRetry={p.redraw} onTurnOn={() => ui.patch({ settings: 'experimental' })} url={target.kind === 'url' ? target.url : undefined} />
          ) : !shown ? (
            <div className={s.skeleton}>
              <span className={s.skeletonPulse} />
              {seen ? `Drawing ${name}…` : title}
            </div>
          ) : null}
        </div>
        <EventsStrip events={p.events} />
        {p.audit ? <AuditPanel issues={p.audit} onShow={p.highlight} onAgain={p.check} onClose={p.closeAudit} /> : null}
        {showProps && p.ok && fields.length && !p.gallery ? (
          <div className={s.panel}>
            <div className={s.panelHead}>
              <span className={s.panelTitle}>Props</span>
              <span className={s.panelHint}>{p.touched.size ? 'Yours are kept for next time.' : 'Filled in from its types. Change any to redraw it.'}</span>
              <span className={s.grow} />
              {variantOf ? (
                <Tip label={`Draw it once for each ${variantOf.name}`}>
                  <button type="button" className={cx(s.choice, p.variants && s.choiceOn)} aria-pressed={p.variants} onClick={() => p.setVariants(!p.variants)}>
                    Every {variantOf.name}
                  </button>
                </Tip>
              ) : null}
              <Button size="small" variant="quiet" disabled={!p.touched.size} onClick={p.reset}>
                Reset
              </Button>
            </div>
            <PropControls fields={fields} values={p.values} onChange={p.change} onClear={p.clear} fired={p.fired} />
          </div>
        ) : null}
      </figure>
    </ActionsContext>
  );
}
