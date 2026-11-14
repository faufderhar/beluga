import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { AppActResult, AppReadResult, AppStepRef, AppToolResult, McpAppView } from '@beluga/shared/mcp-apps.js';
import type { DisplayMode } from '@beluga/mcp-apps/domain/app-requests.js';
import { useApi, useApp } from '../../lib/beluga.js';
import { openExternal } from '../../lib/system.js';
import { AppBridge, type HostContext, MAX_APP_HEIGHT, type ToolResultParams } from './bridge.js';
import { liftForFullscreen } from './fullscreen.js';
import s from './mcp-app.module.css';

/** How tall an app is drawn until it says its size. */
const FIRST_HEIGHT = 160;

type OkView = Extract<McpAppView, { ok: true }>;

/**
 * One MCP App under its Claude card: the server's page in a sealed frame on this computer's app
 * host (its own origin, no referrer), fed the tool's input and result over the bridge. `done`: the
 * tool came back, so the view is asked again for its result.
 */
export const AppFrame = memo(function AppFrame({ channel, itemId, stepId, done }: { channel: string; itemId: string; stepId: string; done: boolean }) {
  const api = useApi();
  const [view, setView] = useState<McpAppView | undefined>();
  useEffect(() => {
    let live = true;
    void (api.apps.get(channel, itemId, stepId) as Promise<McpAppView>)
      .then((v) => live && setView(v))
      .catch((err: unknown) => live && setView({ ok: false, reason: 'unavailable', message: err instanceof Error ? err.message : String(err) }));
    return () => {
      live = false;
    };
  }, [api, channel, itemId, stepId, done]);
  if (!view) return <div className={s.app} data-mcp-app="loading" style={{ height: FIRST_HEIGHT }} />;
  if (!view.ok) return <div className={s.note}>This app can’t be shown: {view.message}</div>;
  return <Frame view={view} at={{ channel, itemId, stepId }} />;
});

function Frame({ view, at }: { view: OkView; at: AppStepRef }) {
  const api = useApi();
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const bridge = useRef<AppBridge | undefined>(undefined);
  const [height, setHeight] = useState(FIRST_HEIGHT);
  const [mode, setMode] = useState<DisplayMode>('inline');
  // An approval waiting in this chat is drawn under the app: fullscreen gives way to it.
  const asking = useApp((st) => st.approvals.some((a) => a.channel === at.channel));
  const result = useMemo(() => resultOf(view), [view]);

  // One bridge per frame address: it answers only the frame's own window.
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const origin = new URL(view.url).origin;
    const b = new AppBridge(
      { hostContext: hostContext(el), input: view.input, result },
      {
        post: (m) => el.contentWindow?.postMessage(m, origin),
        size: setHeight,
        // Beluga gates both (own server, 'app' visibility, readOnly or your Allow).
        call: (name, args) => api.apps.call(at.channel, at.itemId, at.stepId, name, args) as Promise<AppActResult<AppToolResult>>,
        read: (uri) => api.apps.read(at.channel, at.itemId, at.stepId, uri) as Promise<AppActResult<AppReadResult>>,
        message: (params) => api.apps.message(at.channel, at.itemId, at.stepId, asParams(params)) as Promise<AppActResult<object>>,
        context: (params) => api.apps.context(at.channel, at.itemId, at.stepId, asParams(params)) as Promise<AppActResult<object>>,
        openLink: (url) => void openExternal(url),
        displayMode: setMode,
      },
    );
    bridge.current = b;
    const onMessage = (e: MessageEvent): void => {
      if (e.origin === origin) b.receive(e.source, el.contentWindow, e.data);
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      b.teardown();
      bridge.current = undefined;
    };
    // The result that comes later goes in through setResult (below), not a new bridge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.url]);

  useEffect(() => {
    if (result) bridge.current?.setResult(result);
  }, [result]);

  useEffect(() => {
    if (!asking || mode !== 'fullscreen') return;
    setMode('inline');
    bridge.current?.setDisplayMode('inline');
  }, [asking, mode]);

  // Fullscreen covers the window: its rows drop their transforms until it ends or the app goes.
  useEffect(() => {
    if (mode !== 'fullscreen' || !box.current) return;
    return liftForFullscreen(box.current);
  }, [mode]);

  // Esc leaves fullscreen, and the app is told (while the focus is outside the app: its frame takes its own keys).
  useEffect(() => {
    if (mode !== 'fullscreen') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setMode('inline');
      bridge.current?.setDisplayMode('inline');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode]);

  return (
    // Fullscreen is the same frame drawn over the window (never a new one: the app keeps its state).
    <div ref={box} className={s.app} data-mcp-app={view.tool} data-border={view.prefersBorder === false ? 'none' : undefined} data-mode={mode}>
      {mode === 'fullscreen' ? (
        <button
          type="button"
          className={s.exit}
          onClick={() => {
            setMode('inline');
            bridge.current?.setDisplayMode('inline');
          }}
        >
          Exit Full Screen
        </button>
      ) : null}
      <iframe
        ref={frame}
        className={s.frame}
        src={view.url}
        title={`${view.tool} · ${view.server}`}
        sandbox="allow-scripts allow-same-origin allow-forms"
        referrerPolicy="no-referrer"
        style={mode === 'fullscreen' ? undefined : { height: Math.min(height, MAX_APP_HEIGHT) }}
      />
    </div>
  );
}

/** The result as MCP's CallToolResult, the same object while the view reads the same. */
function resultOf(view: OkView): ToolResultParams | undefined {
  const r = view.result;
  if (!r) return undefined;
  return { content: r.text !== undefined ? [{ type: 'text', text: r.text }] : [], ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}), ...(r.isError ? { isError: true } : {}) };
}

/** What the app sent, as the IPC's object (the bridge forwards only objects; anything else is an empty one, refused there). */
function asParams(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
}

function hostContext(el: HTMLElement): HostContext {
  return {
    theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
    displayMode: 'inline',
    containerDimensions: { maxHeight: MAX_APP_HEIGHT, width: Math.round(el.getBoundingClientRect().width) },
    locale: navigator.language,
    platform: 'desktop',
  };
}
