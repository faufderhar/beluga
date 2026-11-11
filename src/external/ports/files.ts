import type { PtyProcess } from '../../terminal/pty-host.js';

/** What the file and terminal tools reach: a folder they then gate themselves, and a terminal by its key. */
export interface FilesPort {
  /** A chat's or a project's folder, and where its tools may also be installed. */
  folder(where: string): { readonly root: string; readonly more: readonly string[] } | undefined;
  terminal(key: string): Pick<PtyProcess, 'write' | 'backlog'> | undefined;
}
