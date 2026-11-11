import type { GitFix, GitTrouble, GitTroubleKind } from '@beluga/shared/git-trouble.js';
import { githubId } from '@beluga/shared/terminal-keys.js';
import { CommandLine, FormSheet } from '../../components/FormSheet.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { type ActionItem, ActionsDropdown } from '../../components/SpecMenu.js';
import { IconButton } from '../../components/ui.js';
import { useApi, useBeluga, toast } from '../../lib/beluga.js';
import { copyText } from '../../lib/copy.js';
import { type GitRetry, showGitTrouble } from '../../lib/git-trouble.js';
import { revealTerminal } from '../../lib/panel.js';
import { openSheet } from '../../lib/sheets.js';
import { openExternal } from '../../lib/system.js';
import { whileBusy } from '../../lib/ws-busy.js';
import s from './git-trouble.module.css';

const KIND_ICON: Record<GitTroubleKind, IconName> = { ssh_denied: 'lock', host_key: 'lock', no_access: 'eyeOff', https_auth: 'person', https_broken: 'lock', gh_missing: 'download', gh_logged_out: 'person', no_remote: 'branch', offline: 'globe' };

/** Fixes that run in the worktree's GitHub terminal, where you see them and answer what they ask. */
const IN_TERMINAL = new Set<GitFix['id']>(['install_gh', 'gh_login', 'add_ssh_key', 'check_host']);

const FIX_ICON: Partial<Record<GitFix['id'], IconName>> = { push_https: 'up', use_https: 'globe', install_gh: 'download', gh_login: 'person', add_ssh_key: 'lock', check_host: 'lock', retry: 'refresh', link: 'external' };

/**
 * Create PR (or Merge, Update Branch) couldn't reach GitHub: what happened in plain words, the one
 * fix most likely to work as the main button, the others behind •••, and git's own words under
 * Details (BLG-213). Nothing about the project changes without a click, and Always Use HTTPS asks again.
 */
export function GitTroubleSheet({ wsId, trouble, retry, close }: { wsId: string; trouble: GitTrouble; retry: GitRetry; close: () => void }) {
  const api = useApi();
  const { client, ui } = useBeluga();
  const [main, ...more] = trouble.fixes;

  const start = (fix: GitFix): void => {
    close();
    if (IN_TERMINAL.has(fix.id)) {
      // The terminal shows the step (it's yours to answer); when it ends well, Beluga tries again by itself.
      ui.patch({ termKey: githubId(wsId) });
      requestAnimationFrame(() => revealTerminal(client.store.getState(), true));
      void api.workbench.gitFix(wsId, fix.id as Exclude<GitFix['id'], 'link'>, retry).then((out) => showGitTrouble(wsId, out, retry), () => undefined);
      return;
    }
    void whileBusy(wsId, async () => showGitTrouble(wsId, await api.workbench.gitFix(wsId, fix.id as Exclude<GitFix['id'], 'link'>, retry), retry));
  };

  const pick = (fix: GitFix): void => {
    if (fix.id === 'link') return void (fix.url && openExternal(fix.url));
    if (fix.id === 'use_https') {
      return openSheet({
        kind: 'confirm',
        title: 'Always use HTTPS for this project?',
        message: `${fix.detail} Pushes then use your GitHub CLI login instead of an SSH key, here and in Terminal.`,
        confirm: 'Use HTTPS',
        run: () => start(fix),
      });
    }
    start(fix);
  };

  const items: ActionItem[] = [
    ...more.map((f): ActionItem => ({ label: f.label, hint: f.detail, ...(FIX_ICON[f.id] ? { icon: FIX_ICON[f.id] } : {}), onSelect: () => pick(f) })),
    {
      label: 'Copy Details',
      icon: 'copy',
      separate: more.length > 0,
      onSelect: () => {
        void copyText(trouble.raw);
        toast(client, 'Copied what git said');
      },
    },
  ];

  if (!main) return null;
  return (
    <FormSheet
      width={500}
      title={trouble.title}
      icon={KIND_ICON[trouble.kind]}
      intro={trouble.explain}
      submitLabel={main.label}
      cancelLabel="Not Now"
      onSubmit={() => {
        pick(main);
      }}
      onCancel={close}
      footer={
        <ActionsDropdown items={items} align="start">
          <IconButton icon="more" label="Other ways to fix it" />
        </ActionsDropdown>
      }
    >
      <div className={s.body}>
        <p className={s.what}>
          <Icon name={FIX_ICON[main.id] ?? 'info'} size={12} />
          <span>{main.detail}</span>
        </p>
        {main.command ? (
          <div className={s.command}>
            <div className={s.commandTitle}>It runs this in Beluga’s terminal, where you answer it:</div>
            <CommandLine command={main.command} />
          </div>
        ) : null}
        {trouble.raw ? (
          <details className={s.details}>
            <summary>Details</summary>
            <pre className="selectable">{trouble.raw}</pre>
          </details>
        ) : null}
      </div>
    </FormSheet>
  );
}
