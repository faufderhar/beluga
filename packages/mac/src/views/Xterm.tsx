import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { type ITheme, Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import { useBeluga } from '../lib/beluga.js';
import { getPrefs, usePrefs } from '../lib/prefs.js';
import { importedTheme, terminalOptions } from '../lib/terminal-look.js';
import { copyText } from '../lib/copy.js';
import { keyPlatform } from '../lib/shortcuts-model.js';
import { openExternal } from '../lib/system.js';
import s from '../views/terminal.module.css';

/** ⌘← start of line (^A), ⌘→ end of line (^E), ⌘⌫ delete to the start (^U). */
const MAC_LINE_KEYS: Readonly<Record<string, string>> = { ArrowLeft: '\x01', ArrowRight: '\x05', Backspace: '\x15' };

/** Drawn output is acked in pieces this big, or after ACK_AFTER_MS for what's left (flow control, BLG-963). */
const ACK_CHARS = 16 * 1024;
const ACK_AFTER_MS = 40;

const css = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
/** Beluga's colours for the window's appearance, with the ones you brought from another terminal over them. */
export const themeNow = (): ITheme & { background: string } => ({ background: css('--term-bg') || css('--bg'), foreground: css('--text'), cursor: css('--accent') === 'AccentColor' ? css('--text') : css('--accent'), selectionBackground: 'rgba(120,140,190,0.35)', ...importedTheme(getPrefs()) });

/** What a terminal's owner may add to it once it's made (links, find, keys of its own). */
export interface XtermTools {
  readonly search: SearchAddon;
  /** Type into the program, as if from the keyboard. */
  readonly write: (data: string) => void;
}

export interface XtermProps {
  readonly termKey: string;
  /** Start the program; a promise: attached once it settles (a program that takes a moment). */
  readonly start: (size: { cols: number; rows: number }) => void | Promise<unknown>;
  readonly focus?: boolean;
  /**
   * Draw with the GPU (WebGL), falling back to the DOM when it can't or in Low Power mode. On by
   * default: the DOM can't keep up with a busy program (a build log, Claude Code redrawing).
   */
  readonly gpu?: boolean;
  /** Add to the terminal once it's made → how to take that down. */
  readonly extend?: (term: Terminal, tools: XtermTools) => (() => void) | undefined;
  /** A key for the owner first (⌘F, ⌘D…): true when it took it (the program never sees it). */
  readonly onKey?: (e: KeyboardEvent, term: Terminal) => boolean;
  /**
   * Resize the program once its box has settled (a panel sliding in), not at every step: a
   * full-screen program like Claude Code draws itself again at each new size.
   */
  readonly settleMs?: number;
  /**
   * Keep what's shown against the bottom, the way a chat sits: while the program's lines don't fill
   * the terminal (a fresh start, after it clears), they're drawn at its foot, the prompt last.
   */
  readonly fromBottom?: boolean;
}

/** One terminal program, drawn by xterm.js from its raw bytes (the program runs in Beluga). */
export function Xterm({ termKey, start, focus = true, gpu = true, extend, onKey, settleMs = 0, fromBottom = false }: XtermProps) {
  const own = useRef({ extend, onKey });
  own.current = { extend, onKey };
  const { client } = useBeluga();
  const box = useRef<HTMLDivElement>(null);
  const live = useRef<{ term: Terminal; refit: () => void } | undefined>(undefined);
  const prefs = usePrefs();
  const look = terminalOptions(prefs);
  // The program is started once per terminal: not again when it shows up in the state, when
  // it's closed (that empties the pane), or when React mounts twice in development.
  const startedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // After the frame that shows the switch, not before it: a click's effects run before its paint, and
    // making a terminal (fonts measured, layout read) would hold up the chat you clicked (KLD-68).
    let stop: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => (timer = setTimeout(() => (stop = mount(el)))));
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      stop?.();
    };
  }, [termKey]);
  /** Make the terminal in `el` and connect it to its program → how to take it down. */
  function mount(el: HTMLDivElement): () => void {
    const term = new Terminal({
      ...terminalOptions(getPrefs()),
      allowProposedApi: true,
      theme: themeNow(),
    });
    // The padding around the text in the terminal's own background (an imported one, too).
    el.style.background = themeNow().background;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    const search = new SearchAddon();
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon((_e, uri) => void openExternal(uri)));
    term.open(el);
    // The GPU draws a full-window terminal smoothly; when WebGL isn't there (or its context is lost), the DOM does.
    // Low Power mode (BLG-621): the DOM always, no GPU textures (a terminal opened since it turned on).
    let webgl: WebglAddon | undefined;
    if (gpu && !client.store.getDomain().powerSaving) {
      try {
        webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl?.dispose();
          webgl = undefined;
        });
        term.loadAddon(webgl);
      } catch {
        webgl = undefined;
      }
    }
    fit.fit();
    const started = startedFor.current !== termKey && !(termKey in client.store.getState().terminals) ? start({ cols: term.cols, rows: term.rows }) : undefined;
    startedFor.current = termKey;
    // A program that takes a moment to start (the agent's terminal: Claude Code made ready, its
    // tools served) is attached to once it's there; until then what you type waits.
    let link: ReturnType<typeof client.attachTerminal> | undefined;
    let offData: (() => void) | undefined;
    let offExit: (() => void) | undefined;
    let gone = false;
    const waiting: string[] = [];
    // Flow control (BLG-963): what xterm has drawn and the daemon hasn't heard about yet. The program
    // waits while we're far behind, so what you type never queues behind megabytes still to draw.
    let drawn = 0;
    // What came in and isn't acked yet, and which round of writes still acks once drawn.
    let owed = 0;
    let round = 0;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    const ackNow = (): void => {
      clearTimeout(ackTimer);
      ackTimer = undefined;
      if (drawn && !gone) link?.ack?.(drawn);
      drawn = 0;
    };
    const drew = (chars: number): void => {
      owed -= chars;
      drawn += chars;
      if (drawn >= ACK_CHARS) ackNow();
      else ackTimer ??= setTimeout(ackNow, ACK_AFTER_MS);
    };
    const output = (d: string): void => {
      owed += d.length;
      if (document.hidden) return void (term.write(d), drew(d.length));
      const r = round;
      term.write(d, () => r === round && drew(d.length));
    };
    // A hidden window draws slowly, if at all: it never makes a build wait. All it owes is acked now, and as it comes.
    const hidden = (): void => {
      if (!document.hidden || !owed) return;
      round++;
      drew(owed);
      ackNow();
    };
    document.addEventListener('visibilitychange', hidden);
    const send = (d: string): void => (link ? link.write(d) : void waiting.push(d));
    const attach = (): void => {
      if (gone) return;
      const l = client.attachTerminal(termKey, { flow: true });
      link = l;
      offData = l.onData(output);
      offExit = l.onExit((e) => term.write(`\r\n\x1b[2m[exited${e.code !== null ? ` with ${e.code}` : ''}]\x1b[0m\r\n`));
      l.resize(term.cols, term.rows);
      for (const d of waiting.splice(0)) l.write(d);
    };
    if (started && typeof (started as Promise<unknown>).then === 'function') void (started as Promise<unknown>).then(attach, attach);
    else attach();
    const input = term.onData(send);
    const extra = own.current.extend?.(term, { search, write: send });
    // The Mac's line keys, as Terminal and iTerm send them: xterm leaves ⌘ keys to the app.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && own.current.onKey?.(e, term)) {
        e.preventDefault();
        return false;
      }
      // Linux and Windows terminals copy and paste with Ctrl+Shift+C and V (Ctrl+C is the shell's).
      if (keyPlatform() !== 'mac' && e.ctrlKey && e.shiftKey && !e.altKey && /^[cv]$/i.test(e.key)) {
        if (e.type !== 'keydown') return false;
        e.preventDefault();
        if (e.key.toLowerCase() === 'c') void copyText(term.getSelection());
        else void navigator.clipboard.readText().then((t) => t && term.paste(t), () => undefined);
        return false;
      }
      const line = keyPlatform() === 'mac' && e.type === 'keydown' && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey ? MAC_LINE_KEYS[e.key] : undefined;
      if (!line) return true;
      e.preventDefault();
      send(line);
      return false;
    });
    // A click in the padding around the text types here too, so Tab completes instead of moving focus away.
    const grab = (e: MouseEvent): void => {
      if (e.button === 0 && !term.element?.contains(e.target as Node)) {
        e.preventDefault();
        term.focus();
      }
    };
    el.addEventListener('mousedown', grab);
    const refit = (): void => {
      // Not on screen (its tab is behind another one, its dock is folded): it keeps the size it had.
      if (!el.offsetWidth || !el.offsetHeight) return;
      try {
        fit.fit();
        link?.resize(term.cols, term.rows);
      } catch {
        // detached
      }
    };
    // Against the bottom: the screen is moved down by the rows under the last one in use (until it's full).
    const anchored = fromBottom
      ? term.onRender(() => {
          const b = term.buffer.active;
          const box = term.element;
          if (!box) return;
          let last = b.cursorY;
          for (let y = term.rows - 1; y > last; y--) {
            if (b.getLine(b.viewportY + y)?.translateToString(true).trim()) {
              last = y;
              break;
            }
          }
          const free = b.baseY > 0 || b.type === 'alternate' ? 0 : term.rows - 1 - last;
          const row = (box.querySelector('.xterm-screen') as HTMLElement | null)?.clientHeight ?? 0;
          const shift = free > 0 && row ? Math.round((free * row) / term.rows) : 0;
          box.style.transform = shift ? `translateY(${shift}px)` : '';
        })
      : undefined;
    // A box that's still moving (a panel sliding in) is fitted once it stops.
    let settle: ReturnType<typeof setTimeout> | undefined;
    const settled = (): void => {
      clearTimeout(settle);
      settle = setTimeout(refit, settleMs);
    };
    live.current = { term, refit };
    // The e2e tests read what a terminal shows (a GPU-drawn one has no text in the page).
    if (import.meta.env.DEV) ((window as unknown as { __belugaTerms?: Record<string, Terminal> }).__belugaTerms ??= {})[termKey] = term;
    const resize = new ResizeObserver(settleMs > 0 ? settled : refit);
    resize.observe(el);
    // Follow the appearance (light/dark, the theme, accent) as it changes.
    const restyle = new MutationObserver(() => {
      term.options.theme = themeNow();
      el.style.background = themeNow().background;
    });
    restyle.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette', 'style', 'class'] });
    if (focus) term.focus();
    return () => {
      live.current = undefined;
      clearTimeout(settle);
      clearTimeout(ackTimer);
      document.removeEventListener('visibilitychange', hidden);
      anchored?.dispose();
      el.removeEventListener('mousedown', grab);
      resize.disconnect();
      restyle.disconnect();
      extra?.();
      input.dispose();
      webgl?.dispose();
      gone = true;
      offData?.();
      offExit?.();
      link?.close?.();
      term.dispose();
    };
  }
  // Your terminal look (Settings › Terminal) applies as you change it; size changes refit.
  useEffect(() => {
    const t = live.current;
    if (!t) return;
    t.term.options = { ...look, theme: themeNow() };
    if (box.current) box.current.style.background = themeNow().background;
    t.refit();
  }, [look.fontFamily, look.fontSize, look.lineHeight, look.cursorStyle, look.cursorBlink, look.scrollback, look.macOptionIsMeta, prefs.termTheme]);
  return <div ref={box} className={s.xterm} />;
}

