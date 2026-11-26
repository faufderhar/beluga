import type { RunProcess } from '../../types.js';
import type { CodexRpc } from '../codex/rpc.js';
import type { InitializeResponse } from '../opencode/acp.js';
import type { AcpLimits } from './watch.js';

/**
 * One ACP agent as Beluga runs it: how it's found, started and signed in. What it does beyond the
 * protocol (its tools' names, its questions, its quota) is its extension (extension.ts).
 */
export interface AcpAgentSpec {
  /** Its runtime id ('antigravity'). */
  readonly id: string;
  /** Its name for people ('Antigravity'). */
  readonly label: string;
  /** Its executable's name, without `.exe` ('agy'). */
  readonly command: string;
  /** What starts its ACP server (['acp']). */
  readonly args: readonly string[];
  /** Set on its process, over the run's. */
  readonly env?: Readonly<Record<string, string>>;
  /** A variable that names its executable outright ('BELUGA_AGY_PATH'). */
  readonly pathVar?: string;
  /** Folders to look in after PATH (where its installer puts it, Homebrew's). */
  readonly searchDirs?: (platform: NodeJS.Platform, home: string) => readonly string[];
  /** Its flag for one more folder a run may work in ('--add-dir'). */
  readonly addDirFlag?: string;
  /** Not installed, as a run's error says it. */
  readonly missingWords: (where: string) => string;
  /** Not installed, as the picker's fix says it. */
  readonly installFix: string;
  /** Not signed in, as the picker's fix says it. */
  readonly signInFix: string;
  /** Its own patience, over the watch's (watch.ts): an agent slow to start takes a longer `setup`. */
  readonly limits?: Partial<AcpLimits>;
}

/** One ACP agent's process for a run (or a look): its JSON-RPC, its process, what it said it can do. */
export interface AcpConnection {
  readonly rpc: CodexRpc;
  readonly proc: RunProcess;
  readonly init: InitializeResponse;
  /** Its last stderr lines, for a failure's details. */
  readonly stderr: () => readonly string[];
  /** Why it ended, when its line knows (stuck, not signed in, how it exited); undefined while it runs on. */
  readonly cause?: () => string | undefined;
  /** Notes for the chat while a turn runs (it went quiet). */
  readonly onNotice?: (fn: (note: string) => void) => void;
}

export interface AcpConnectOptions {
  readonly cwd: string;
  /** Its whole environment (the run's env over Beluga's). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Its executable; unset: findAcpCommand(). */
  readonly bin?: string;
  /** Flags for this process (its extra folders). */
  readonly args?: readonly string[];
  /** A look, not a run (a status check, a quota read, a side call): the extension's afterLook runs once it has stopped. */
  readonly look?: boolean;
}

/** How a run reaches an ACP agent: spawn it (tests hand a scripted one instead). */
export type AcpConnect = (opts: AcpConnectOptions) => Promise<AcpConnection>;
