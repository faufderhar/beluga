import { WebSocket } from 'ws';
import { runningDaemon } from '../daemon/files.js';
import type { Args, Method } from '../ipc/api.js';
import { IPC_VERSION, encodeFrame, parseDaemonFrame } from '../ipc/protocol.js';
import { installedVersion } from '../core/version.js';

const TIMEOUT_MS = 10_000;

/** Whether a Beluga daemon is running on this computer. */
export const daemonRunning = (): boolean => runningDaemon() !== undefined;

/** One API call to the running daemon, as a screen makes it: its token from daemon.json, then the call. */
export function callDaemon<M extends Method>(method: M, ...args: Args<M> extends readonly unknown[] ? Args<M> : never): Promise<unknown> {
  return callDaemonWithin(TIMEOUT_MS, method, ...args);
}

/** The same, for a call that waits on you (a card on the Mac). */
export function callDaemonWithin<M extends Method>(timeoutMs: number, method: M, ...args: Args<M> extends readonly unknown[] ? Args<M> : never): Promise<unknown> {
  const info = runningDaemon();
  if (!info) return Promise.reject(new Error('Beluga is not running. Open the app first.'));
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}`);
    const finish = (settle: () => void): void => {
      clearTimeout(timer);
      ws.close();
      settle();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('Beluga did not answer in time'))), timeoutMs);
    ws.once('error', (err) => finish(() => reject(err)));
    ws.once('open', () => ws.send(encodeFrame({ t: 'hello', token: info.token, ipc: IPC_VERSION, kind: 'cli', version: installedVersion(), caps: [] })));
    ws.on('message', (raw: Buffer) => {
      const frame = parseDaemonFrame(raw.toString());
      if (frame.t === 'welcome') ws.send(encodeFrame({ t: 'call', id: '1', method, args: [...args] }));
      else if (frame.t === 'bye') finish(() => reject(new Error(frame.reason)));
      else if (frame.t === 'result' && frame.id === '1') finish(() => (frame.ok ? resolve(frame.value) : reject(new Error(frame.error ?? 'failed'))));
    });
  });
}
