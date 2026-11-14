import type { ReactNode } from 'react';
import type { AppState } from '@beluga/core/store.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { shareNameOf } from '@beluga/shared/share-names.js';
import { baseName, sepOf } from '@beluga/shared/os-path.js';
import { relativeCandidates, scratchCandidates, type PathRef } from '@beluga/shared/render/path-refs.js';
import { SCRATCH_DIR } from '@beluga/shared/scratch-dir.js';
import { Icon } from '../components/Icon.js';
import { ActionsContext, type ActionItem } from '../components/SpecMenu.js';
import { useActions } from '../lib/actions.js';
import { useBeluga } from '../lib/beluga.js';
import { copyText } from '../lib/copy.js';
import { localPathOf, revealInFinder } from '../lib/files.js';
import { goToCode } from '../lib/go-to-code.js';
import { revealLabel, thisComputer } from '../lib/os-words.js';
import s from './chat.module.css';
import { useRevealFileLabel, useRevealLabel } from '../lib/remote-open.js';

/** The worktree a relative path is in: the one on screen. */
const worktreeOf = (state: AppState): string | undefined => (state.view.kind === 'workspace' ? state.view.id : undefined);

/**
 * Where a path may be on this Mac, in order: a relative one in the worktree on screen (from its root,
 * then from its .beluga folder), "~" left for the daemon to expand.
 */
function fullPaths(state: AppState, ref: PathRef): readonly string[] {
  if (!ref.relative) return [ref.path];
  const ws = worktreeOf(state);
  if (!ws) return [];
  return relativeCandidates(ref.path).flatMap((path) => localPathOf(state, { owner: state.selfId, share: shareNameOf(ws), path }) ?? []);
}

/** A file's place in the worktree on screen, when it's in it. */
function inWorktree(state: AppState, file: string): { ws: string; path: string } | undefined {
  const ws = worktreeOf(state);
  const root = ws ? localPathOf(state, { owner: state.selfId, share: shareNameOf(ws), path: '' })?.replace(/[\\/]+$/, '') : undefined;
  return ws && root && file.startsWith(root + sepOf(root)) ? { ws, path: file.slice(root.length + 1) } : undefined;
}

type Found = { path: string; kind: 'file' | 'folder' };

/** How many checkouts in the scratch folder a link looks through (statFiles takes 20 at a time). */
const MAX_SCRATCH_FOLDERS = 40;
const STAT_BATCH = 20;

/** The first of these paths that is there, in order. */
async function firstThere(client: SocketClient, candidates: readonly string[]): Promise<Found | undefined> {
  for (let i = 0; i < candidates.length; i += STAT_BATCH) {
    const infos = await client.api.local.statFiles(candidates.slice(i, i + STAT_BATCH));
    const info = infos.find((x) => x.kind !== 'missing');
    if (info && info.kind !== 'missing') return { path: info.path, kind: info.kind };
  }
  return undefined;
}

/** A relative path named from a checkout the agent made in the scratch folder (BLG-956). */
async function inScratchCheckouts(client: SocketClient, ref: PathRef): Promise<Found | undefined> {
  const state = client.store.getState();
  const ws = worktreeOf(state);
  if (!ref.relative || !ws) return undefined;
  const scratch = localPathOf(state, { owner: state.selfId, share: shareNameOf(ws), path: SCRATCH_DIR });
  if (!scratch) return undefined;
  const folders = (await client.api.local.listDirs(scratch)).map((e) => e.name).slice(0, MAX_SCRATCH_FOLDERS);
  const candidates = scratchCandidates(ref.path, folders).flatMap((path) => localPathOf(state, { owner: state.selfId, share: shareNameOf(ws), path }) ?? []);
  return firstThere(client, candidates);
}

/** What the path is on this Mac now (a file, a folder, or nothing), with "~" expanded. */
async function lookUp(client: SocketClient, ref: PathRef): Promise<Found | undefined> {
  const candidates = fullPaths(client.store.getState(), ref);
  if (!candidates.length) return undefined;
  return (await firstThere(client, candidates)) ?? (await inScratchCheckouts(client, ref));
}

/**
 * A file or folder Claude named in the chat (shared/render/path-refs.ts), as a link: a file opens
 * in the viewer (at its line), a folder in Files. Right-click to show it in Finder or copy its path.
 */
export function PathLink({ pathRef: ref, children }: { pathRef: PathRef; children: ReactNode }) {
  const { client } = useBeluga();
  const actions = useActions();
  const looksLikeFolder = ref.dir || !/\.[^./\\]+$/.test(baseName(ref.path));
  // On a computer's page: Download for a file, Copy Path for a folder (BLG-852).
  const revealFile = useRevealFileLabel();
  const revealFolder = useRevealLabel();
  // A relative path is only looked for in the worktree on screen, so say so, not "on this Mac" (BLG-956).
  const missing = (): void =>
    client.store.dispatch({ type: 'toast', text: ref.relative ? `Can’t find ${ref.path} in this worktree` : `Can’t find ${ref.path} on ${thisComputer()}`, level: 'warn' });
  const open = async (): Promise<void> => {
    const found = await lookUp(client, ref);
    if (!found) return missing();
    // A file of this worktree (however it was written): straight to it, at its line (Esc goes back to the chat).
    const inside = found.kind === 'file' ? inWorktree(client.store.getState(), found.path) : undefined;
    if (inside) return goToCode(client, inside.ws, inside.path, ref.line);
    actions.openLink({ kind: 'local', path: found.path, dir: found.kind === 'folder', ...(ref.line ? { line: ref.line } : {}) });
  };
  const items = (): readonly ActionItem[] => [
    { label: looksLikeFolder ? 'Open Folder' : 'Open', icon: looksLikeFolder ? 'folder' : 'file', onSelect: () => void open() },
    { label: looksLikeFolder ? revealFolder : revealFile, onSelect: () => void lookUp(client, ref).then((found) => (found ? revealInFinder(client, found.path) : missing())) },
    {
      label: 'Copy Path',
      icon: 'copy',
      separate: true,
      onSelect: () =>
        void lookUp(client, ref)
          .then((found) => copyText(found?.path ?? ref.path))
          .then(() => client.store.dispatch({ type: 'toast', text: 'Copied the path', level: 'success' })),
    },
  ];
  return (
    <ActionsContext items={items}>
      <a
        href={ref.path}
        className={s.pathLink}
        title={ref.line ? `${ref.path}, line ${ref.line}` : ref.path}
        onClick={(e) => {
          e.preventDefault();
          void open();
        }}
      >
        <Icon name={looksLikeFolder ? 'folder' : 'file'} size={11} />
        {children}
      </a>
    </ActionsContext>
  );
}
