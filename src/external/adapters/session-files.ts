import type { Session } from '../../core/session.js';
import type { FilesPort } from '../ports/files.js';

/** The file port over a daemon's session. */
export function sessionFiles(session: Session): FilesPort {
  return {
    folder: (where) => {
      const project = session.store.getState().projects.find((p) => p.root && p.id === where);
      if (project) return { root: project.root, more: [] };
      const ws = session.workspaces?.manager.find(where);
      if (!ws?.path || ws.archived) return undefined;
      return { root: ws.path, more: ws.projectRoot && ws.projectRoot !== ws.path ? [ws.projectRoot] : [] };
    },
    terminal: (key) => session.workbench?.terminals?.get(key),
  };
}
