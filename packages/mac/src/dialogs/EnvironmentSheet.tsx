import { FormSheet } from '../components/FormSheet.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { useApp } from '../lib/beluga.js';
import { openSheet } from '../lib/sheets.js';
import { thisComputer } from '../lib/os-words.js';
import { EnvEditor } from './EnvEditor.js';
import { ProjectSettings, type ProjectTab } from './native/ProjectSettingsSheet.js';
import e from './env-settings.module.css';

/**
 * A project's Environment… (BLG-369): its settings sheet on the Environment tab (BLG-926), from the
 * project's ••• menu, its page's Environment pill and section, and Settings › Environment's list.
 */
export function EnvironmentSheet({ projectId, tab = 'environment', close }: { projectId: string; tab?: ProjectTab; close: () => void }) {
  return <ProjectSettings projectId={projectId} tab={tab} close={close} />;
}

/**
 * A worktree's own variables (BLG-924): what it gets from below greyed, and what's set here
 * winning over all of it, in this worktree only. Archiving or deleting it offers to carry them
 * to the project.
 */
export function WorktreeEnvSheet({ workspaceId, close }: { workspaceId: string; close: () => void }) {
  const ws = useApp((st) => findWorkspace(st.projects, workspaceId));
  const project = useApp((st) => st.projects.find((p) => p.id === ws?.projectId));
  if (!ws || !project) return null;
  return (
    <FormSheet
      title={`Environment for ${ws.name}`}
      icon="branch"
      intro={`Only for this worktree: they win over ${project.name}’s, its .env and yours. They stay on ${thisComputer()}.`}
      submitLabel="Done"
      hideSubmit
      cancelLabel="Done"
      width={640}
      scrolls
      onSubmit={close}
      onCancel={close}
      footer={
        <button
          type="button"
          className={e.inlineLink}
          onClick={() => {
            close();
            openSheet({ kind: 'project_env', projectId: project.id });
          }}
        >
          {project.name}’s variables…
        </button>
      }
    >
      <div className={e.sheetBody} data-sheet-scroll>
        <EnvEditor projectId={project.id} worktreeId={ws.id} />
      </div>
    </FormSheet>
  );
}
