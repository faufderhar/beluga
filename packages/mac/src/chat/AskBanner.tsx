import { activityOf, findWorkspace } from '@beluga/ui/workspace-models.js';
import { Icon } from '../components/Icon.js';
import { Button, Dot, Tip } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { openSheet } from '../lib/sheets.js';
import s from './ask.module.css';

const HINT = 'This chat becomes a worktree from the latest origin; your agent goes on in it';

/** "Continue in New Worktree…": the way out of a questions-only chat (opens its sheet). */
export function ContinueButton({ wsId, className, variant = 'primary' }: { wsId: string; className?: string; variant?: 'primary' | 'plain' }) {
  return (
    <Tip label={HINT}>
      <Button size="small" variant={variant} icon="branch" className={className} onClick={() => openSheet({ kind: 'continue_worktree', wsId })}>
        Continue in New Worktree…
      </Button>
    </Tip>
  );
}

/**
 * Above the message box of a chat in a project's main folder: it's for questions, and the
 * button moves the conversation somewhere Claude can work. (Asking Claude for a change there
 * moves it too.)
 */
export function AskBanner({ wsId }: { wsId: string }) {
  const sync = useApp((st) => findWorkspace(st.projects, wsId)?.purpose === 'sync_main');
  const running = useApp((st) => activityOf(st.log, `ws:${wsId}`).running);
  if (sync) return <SyncBanner running={running} />;
  return (
    <div className={s.wrap}>
      <div className={s.banner} role="note" aria-label="Questions only">
        <Icon name="eye" size={13} className={s.icon} />
        <span className={s.text}>
          <span className={s.lead}>Questions only</span> — your agent won’t change anything in main. Ask for a change and this chat becomes a worktree.
        </span>
        <ContinueButton wsId={wsId} variant="plain" className={s.button} />
      </div>
    </div>
  );
}

/**
 * A conversation where Claude brings main up to date ("Let Claude handle it" on the project
 * home): that one run may sync git in the main folder; afterwards it's questions only again.
 */
function SyncBanner({ running }: { running: boolean }) {
  return (
    <div className={s.wrap}>
      <div className={s.banner} role="note" aria-label={running ? 'Your agent is updating main' : 'Updating main'}>
        {running ? <Dot tone="claude" live /> : <Icon name="download" size={13} className={s.icon} />}
        <span className={s.text}>
          {running ? (
            <>
              <span className={s.lead}>Your agent is updating main</span> — it may only sync git here (fetch, merge or rebase, stash, resolve conflicts). It keeps your changes and never pushes.
            </>
          ) : (
            <>
              <span className={s.lead}>Updating main</span> — your agent’s update run is over; from here on this chat is questions only.
            </>
          )}
        </span>
      </div>
    </div>
  );
}
