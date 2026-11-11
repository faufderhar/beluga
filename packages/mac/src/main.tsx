// First: zod never probes eval (blocked by the CSP, BLG-672), and Beluga's storage keys become Beluga's before any module reads them.
import './lib/zod-jitless.js';
import './lib/storage-rename.js';
import { Fragment, StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { followOwnWords } from './i18n/own.js';
import { startI18n } from './i18n/start.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { App } from './App.js';
import { brandText } from './lib/brand.js';
import { capabilities, connect, inApp } from './lib/boot.js';
import { BelugaProvider } from './lib/beluga.js';
import { apply, zoom } from './lib/prefs.js';
import { watchWindow } from './lib/window-active.js';
import { watchPreloadErrors } from './lib/lazy-view.js';
import { Button } from './components/ui.js';
import { UpdateLayer } from './dialogs/UpdateSheet.js';
import { FolderBrowserHost } from './dialogs/FolderBrowser.js';
import { PartBoundary } from './lib/part-boundary.js';
import s from './layout/Shell.module.css';
import './styles/tokens.css';
import './styles/base.css';

apply();
if (inApp()) document.documentElement.dataset.app = 'tauri';
watchWindow();
watchPreloadErrors();

/** Attach to Beluga, and keep trying while it starts (or comes back). */
function Root() {
  const [client, setClient] = useState<SocketClient>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);
  useEffect(() => {
    let alive = true;
    // Waits longer each time in a row it fails (up to 10 s), so a broken Beluga isn't hammered.
    const retry = (): void => void setTimeout(() => alive && setAttempt((n) => n + 1), Math.min(10_000, 500 * 2 ** Math.min(failures.current++, 5)));
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Beluga didn't answer")), 15_000));
    Promise.race([connect(capabilities(zoom)), timeout])
      .then((c) => {
        if (!alive) return c.close();
        setError(undefined);
        // Before the first draw: names people gave things stay as they are (i18n/own.ts).
        const offWords = followOwnWords(c.store);
        setClient(c);
        const since = Date.now();
        c.onClose(() => {
          offWords();
          setClient(undefined);
          // Dropped right away (Beluga turned the screen away): wait before trying again.
          if (Date.now() - since < 5000) return retry();
          failures.current = 0;
          setAttempt((n) => n + 1);
        });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
        retry();
      });
    return () => {
      alive = false;
    };
  }, [attempt]);
  if (!client) {
    return (
      <div className={s.connecting} data-tauri-drag-region>
        <UpdateLayer connected={false} />
        <div className={s.connectBox}>
          <strong>{error ? 'Beluga isn’t running yet' : 'Starting Beluga…'}</strong>
          {error ? <span>{brandText(error)}</span> : null}
          {error ? <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button> : null}
        </div>
      </div>
    );
  }
  return (
    // Anything that throws while drawing shows why, with a way back, instead of a grey window (BLG-905).
    <PartBoundary part="window" onCrash={(crash) => void client.api.diagnostics.windowCrash(crash).catch(() => undefined)} fallback={(error) => <WindowBroken error={error} />}>
      <BelugaProvider client={client}>
        <App />
        <UpdateLayer connected />
        {/* A browser's folder picker, and in the app a computer's (BLG-793). */}
        <FolderBrowserHost />
      </BelugaProvider>
    </PartBoundary>
  );
}

/** The whole window couldn't be drawn: what went wrong, and Reload (your agents and terminals keep running). */
function WindowBroken({ error }: { error: Error }) {
  return (
    <div className={s.connecting} data-tauri-drag-region>
      <div className={s.connectBox} role="alert">
        <strong>Beluga’s window ran into a problem</strong>
        <span>{brandText(error.message)}</span>
        <span>Reloading the window brings it back. Your agents and terminals keep running, and Report a Problem in Settings › About includes what happened.</span>
        <Button onClick={() => location.reload()}>Reload Window</Button>
      </div>
    </div>
  );
}

/**
 * StrictMode draws everything twice while developing (never in the app you ship): a timing test
 * (e2e/render-calm.spec.ts) opens `/?nostrict` to time what the app itself does.
 */
const Strict = import.meta.env.DEV && new URLSearchParams(location.search).has('nostrict') ? Fragment : StrictMode;

// The window's language first (src/i18n), so its first frame is already in it.
void startI18n({ native: true }).then(() =>
  createRoot(document.getElementById('root')!).render(
    <Strict>
      <Root />
    </Strict>,
  ),
);
