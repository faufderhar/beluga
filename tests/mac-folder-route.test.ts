import { describe, expect, it } from 'vitest';
import type { AppState, Location } from '../src/core/store.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { folderRoute } from '../packages/mac/src/lib/folder-route.js';

// BLG-958: a folder linked in the chat opens where Beluga can show it, else in Finder.

const workspace = (id: string, kind: 'main' | 'worktree'): Workspace => ({ id, kind, path: `/code/app/${id}`, projectId: 'p1', external: false }) as unknown as Workspace;
const project = { id: 'p1', name: 'app', root: '/code/app', base: 'main', workspaces: [workspace('main-1', 'main'), workspace('w 2', 'worktree')] } as Project;
const state: Pick<AppState, 'selfId' | 'projects' | 'myShares'> = {
  selfId: 'me',
  projects: [project],
  myShares: [
    { name: 'docs', root: '/Users/me/docs' },
    { name: 'klaud-attachments', root: '/Users/me/.beluga/attachments', private: true },
    { name: 'local-0123456789', root: '/Users/me/.beluga/outbox', private: true },
  ],
};
const at = (share: string, path = ''): Location => ({ owner: 'me', share, path });

describe('where a folder linked in the chat opens', () => {
  it('opens a folder of a worktree or a project in its Files', () => {
    expect(folderRoute(state, at('ws-w_2', 'src'))).toEqual({ kind: 'worktree', wsId: 'w 2' });
    expect(folderRoute(state, at('ws-main-1'))).toEqual({ kind: 'worktree', wsId: 'main-1' });
  });

  it('opens a folder you share with the room in Files', () => {
    expect(folderRoute(state, at('docs', 'notes'))).toEqual({ kind: 'files' });
  });

  it('opens a folder outside every project and share in Finder', () => {
    // localLocation made a private share just for it: no Files shows that.
    expect(folderRoute(state, at('local-0123456789'))).toEqual({ kind: 'finder' });
    expect(folderRoute(state, at('local-fedcba9876'))).toEqual({ kind: 'finder' });
    // ~/.beluga/attachments: the share friends fetch room images from, private, not browsable here.
    expect(folderRoute(state, at('klaud-attachments'))).toEqual({ kind: 'finder' });
  });

  it('leaves a friend’s folder to Files', () => {
    expect(folderRoute(state, { owner: 'bob', share: 'local-0123456789', path: '' })).toEqual({ kind: 'files' });
  });
});
