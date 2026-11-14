import { useEffect, useState } from 'react';
import { Segmented } from '../../components/ui.js';
import { EnvEditor } from '../EnvEditor.js';
import { EnvAgentGroups } from '../EnvironmentSettings.js';
import { EnvWorktreeGroups } from '../EnvWorktreeGroups.js';
import e from '../env-settings.module.css';
import type { ResolvedScripts } from '@beluga/workspaces/scripts.js';
import { agentMark } from '@beluga/shared/agent-marks.js';
import { agentChoices, agentForChoice, choiceForAgent } from '@beluga/ui/agent-choice.js';
import { agentEntries } from '../../chat/ModelPicker.js';
import { Checkbox, Field, FormSheet, Popup, SourceTag, TextInput } from '../../components/FormSheet.js';
import { agentName, useMyAgent } from '../../lib/agent-words.js';
import { useApi, useApp } from '../../lib/beluga.js';
import { thisComputer } from '../../lib/os-words.js';
import type { NativeMenuProps } from './index.js';

type Kind = 'setup' | 'run';
type Source = NonNullable<ResolvedScripts['setup']>['source'];

const SOURCE: Record<Source, { label: string; tone: 'team' | 'mine' | 'guess'; detail: string }> = {
  yours: { label: 'Your settings', tone: 'mine', detail: 'Only you have it' },
  claude: { label: 'By your agent', tone: 'guess', detail: 'Your agent worked it out from the project (only you have it). Change it if it’s wrong' },
  'beluga.json': { label: 'beluga.json', tone: 'team', detail: 'Shared with everyone on the project' },
  'klaud.json': { label: 'klaud.json', tone: 'team', detail: 'Shared with everyone on the project' },
  'conductor.json': { label: 'conductor.json', tone: 'team', detail: 'A setup file in the project, shared with everyone on it' },
  detected: { label: 'Guessed', tone: 'guess', detail: 'Beluga guessed it from the project. Change it if it’s wrong' },
};

export type ProjectTab = 'general' | 'environment' | 'worktrees';

const TABS: ReadonlyArray<{ value: ProjectTab; label: string; hint: string }> = [
  { value: 'general', label: 'General', hint: 'Setup, Run and its agent' },
  { value: 'environment', label: 'Environment', hint: 'Its variables and .env' },
  { value: 'worktrees', label: 'Worktrees', hint: 'How worktrees share env' },
];

/** ⌘K › Project Settings…, a terminal's Commands…: the General tab. */
export function ProjectSettingsSheet({ menu, close }: NativeMenuProps<'scripts'>) {
  return <ProjectSettings projectId={menu.projectId} tab={menu.tab ?? 'general'} close={close} />;
}

/**
 * A project's settings in one sheet (BLG-926), on three tabs: General (its Setup and Run commands,
 * where each one comes from now and whether they go in beluga.json, and its agent), Environment
 * (its variables beside its main folder's .env, saved as you go) and Worktrees (how they share env,
 * and the ones with variables of their own). Done saves General's changes too.
 */
export function ProjectSettings({ projectId, tab: first, close }: { projectId: string; tab: ProjectTab; close: () => void }) {
  const api = useApi();
  const [tab, setTab] = useState<ProjectTab>(first);
  const project = useApp((st) => st.projects.find((p) => p.id === projectId));
  const autoSetup = useApp((st) => st.prefs.autoSetup);
  const projectAgents = useApp((st) => st.prefs.projectAgents);
  const models = useApp((st) => st.models);
  const runtimes = useApp((st) => st.runtimes);
  const mine = useMyAgent();
  // Usage statistics (BLG-922): a project can be left out, whatever the level.
  const telemetry = useApp((st) => st.telemetry);
  const sharesNow = !project || !(telemetry.excluded ?? []).includes(project.root);
  const [shares, setShares] = useState(sharesNow);
  const scripts = project?.scripts ?? {};
  const [values, setValues] = useState<Record<Kind, string>>({ setup: scripts.setup?.command ?? '', run: scripts.run?.command ?? '' });
  const [team, setTeam] = useState(false);
  const [auto, setAuto] = useState(autoSetup);
  const [touched, setTouched] = useState(false);
  // '~': the same agent as yours (Settings); anything else is this project's own.
  const agentNow = project && projectAgents?.[project.name] ? choiceForAgent(projectAgents[project.name]) : '~';
  const [agent, setAgent] = useState(agentNow);
  // Until you type, the fields follow what's saved (it can arrive just after the sheet opens).
  const setupNow = scripts.setup?.command ?? '';
  const runNow = scripts.run?.command ?? '';
  useEffect(() => {
    if (!touched) setValues({ setup: setupNow, run: runNow });
  }, [setupNow, runNow]);
  if (!project) return null;

  const saved = (kind: Kind): string => scripts[kind]?.command ?? '';
  const edited = (kind: Kind): boolean => values[kind].trim() !== saved(kind);
  const tag = (kind: Kind) => {
    const s = scripts[kind];
    if (edited(kind)) return <SourceTag tone={team ? 'team' : 'mine'}>{team ? 'Will go in beluga.json' : 'Will be yours'}</SourceTag>;
    return s ? (
      <span title={SOURCE[s.source].detail}>
        <SourceTag tone={SOURCE[s.source].tone}>{SOURCE[s.source].label}</SourceTag>
      </span>
    ) : (
      <SourceTag tone="guess">None</SourceTag>
    );
  };
  // Guessed values say so (once), so you check them.
  const hint = (kind: Kind, what: string) => (!edited(kind) && scripts[kind]?.source === 'detected' ? `${what} Guessed from the project: check it.` : !edited(kind) && scripts[kind]?.source === 'claude' ? `${what} Your agent worked it out from the project: check it.` : what);
  const changed = edited('setup') || edited('run') || team || auto !== autoSetup || agent !== agentNow || shares !== sharesNow;
  // Only where there's something to leave out: a build that sends, at a level that sends.
  const offersShare = telemetry.available && Boolean(telemetry.level) && telemetry.level !== 'off';

  const save = (): void => {
    for (const kind of ['setup', 'run'] as const) {
      const value = values[kind].trim();
      // Saving for the team writes both commands into beluga.json, or the older klaud.json it has (and drops your own ones).
      if (team && (value || scripts[kind])) void api.workbench.setScript(project.id, kind, value, true);
      else if (!team && edited(kind)) void api.workbench.setScript(project.id, kind, value);
    }
    if (auto !== autoSetup) void api.session.setPrefs({ autoSetup: auto });
    if (shares !== sharesNow) void api.telemetry.exclude(project.root, !shares);
    if (agent !== agentNow) {
      const { [project.name]: _, ...others } = projectAgents ?? {};
      void api.session.setPrefs({ projectAgents: agent === '~' ? others : { ...others, [project.name]: agentForChoice(agent, runtimes) } });
    }
    close();
  };

  const general = tab === 'general';
  const tabs = (
    <div className={e.tabs}>
      <Segmented label="Project settings" value={tab} options={TABS} onChange={setTab} />
    </div>
  );
  if (!general) {
    return (
      <FormSheet title={`${project.name} Settings`} icon={tab === 'environment' ? 'lock' : 'branch'} intro={tab === 'environment' ? `For its terminals, commands and your agent. They stay on ${thisComputer()}.` : undefined} submitLabel={changed ? 'Save' : 'Done'} onSubmit={save} onCancel={close} cancelLabel={changed ? 'Cancel' : 'Close'} width={640} scrolls>
        {tabs}
        <div className={e.sheetBody} data-sheet-scroll>
          {tab === 'environment' ? (
            <>
              <EnvEditor projectId={project.id} />
              <EnvAgentGroups projectId={project.id} />
            </>
          ) : (
            <EnvWorktreeGroups projectId={project.id} />
          )}
        </div>
      </FormSheet>
    );
  }
  return (
    <FormSheet
      title={`${project.name} Settings`}
      icon="terminal"
      intro="The commands every workspace of this project uses. Leave one empty for none."
      submitLabel={changed ? 'Save' : 'Done'}
      onSubmit={save}
      onCancel={close}
      width={640}
      footer={<Checkbox checked={team} onChange={setTeam} label="Save to beluga.json" detail="Everyone on the project gets them (commit the file)" />}
    >
      {tabs}
      <Field label="Setup" htmlFor="script-setup" hint={hint('setup', 'Runs in each new worktree, e.g. to install dependencies.')} aside={tag('setup')}>
        <TextInput id="script-setup" value={values.setup} onChange={(v) => (setTouched(true), setValues({ ...values, setup: v }))} mono placeholder="npm install" />
      </Field>
      <Field label="Run" htmlFor="script-run" hint={hint('run', 'Starts the project when you click Run.')} aside={tag('run')}>
        <TextInput id="script-run" value={values.run} onChange={(v) => (setTouched(true), setValues({ ...values, run: v }))} mono placeholder="npm run dev" />
      </Field>
      <Field label="Agent" htmlFor="project-agent" hint="Runs this project's new conversations and answers when friends write @you about it.">
        <Popup id="project-agent" value={agent} onChange={setAgent} options={[{ value: '~', label: `Same as yours (${agentName(mine)})`, icon: agentMark(mine) }, ...agentEntries(agentChoices(runtimes, models))]} />
      </Field>
      <Field label="">
        <Checkbox checked={auto} onChange={setAuto} label="Run setup in new worktrees" detail="For every project; in its Terminal tab" />
      </Field>
      {offersShare ? (
        <Field label="">
          <Checkbox checked={shares} onChange={setShares} label="Send usage statistics from this project" detail="Off: its agents’ runs send nothing, whatever Settings › General says" />
        </Field>
      ) : null}
    </FormSheet>
  );
}
