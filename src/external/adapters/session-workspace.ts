import { assistantOf } from '../../core/assistant/registry.js';
import { boardOf } from '../../core/board/registry.js';
import { startPrompt } from '../../core/board/work.js';
import { plansOf } from '../../core/plans/registry.js';
import type { Session } from '../../core/session.js';
import { companionOf } from '../../companion/registry.js';
import type { WorkspacePort } from '../ports/workspace.js';

/** The workspace port over a daemon's session. */
export function sessionWorkspace(session: Session): WorkspacePort {
  const board = () => boardOf(session) ?? missing('The task board');
  const controller = () => session.workspaces ?? missing('Worktrees');
  const find = (id: string) => session.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === id);

  return {
    worktree: (ref) => {
      const found = find(ref);
      return found?.kind === 'worktree' && !found.pending ? { id: found.id, projectId: found.projectId, name: found.name, archived: Boolean(found.archived) } : undefined;
    },
    task: (key) => {
      const issue = board().board.get(key);
      return issue && !issue.private ? { key: issue.key, projectId: issue.projectId } : undefined;
    },
    startTask: async (key, by) => {
      const work = board();
      const chatId = await work.start(key, { quiet: true, by: work.agentActor(by) });
      const ctl = controller();
      ctl.manager.setStartedBy(chatId, by);
      await ctl.refresh();
      return { chatId, message: startPrompt(work.board.need(key)) };
    },
    startPlan: async (projectId, goal, by) => {
      const plan = await (plansOf(session) ?? missing('Plans')).createForAgent(projectId, goal, by);
      await controller().refresh();
      return { id: plan.id };
    },
    archive: (id) => controller().archive(id, false, { quiet: true }),
    restore: async (id) => {
      await controller().restore(id);
      return !find(id)?.archived;
    },
    merge: async (id) => {
      const result = await controller().merge(id);
      if (!result) return undefined;
      return result.ok ? { merged: true } : { merged: false, reason: result.reason, files: result.files };
    },
    mac: () => (assistantOf(session) ?? missing('Your Mac')).tools(),
    phone: () => companionOf(session)?.control.toolsFor()?.tools,
    phoneOff: () => (companionOf(session)?.control.useLevel() ?? 'off') === 'off',
    phoneUse: () => companionOf(session)?.control.useLevel() ?? 'off',
  };
}

function missing(what: string): never {
  throw new Error(`${what} need the Beluga app (its daemon).`);
}
