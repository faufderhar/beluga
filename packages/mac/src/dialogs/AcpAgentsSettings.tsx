import { useEffect, useState } from 'react';
import { runtimeMark } from '@beluga/shared/agent-marks.js';
import { Icon } from '../components/Icon.js';
import { ActionsDropdown, type ActionItem } from '../components/SpecMenu.js';
import { Button, Dot, IconButton } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import { thisComputer } from '../lib/os-words.js';
import { CopyCommand } from '../onboarding/AgentsStep.js';
import { agentRows } from '../onboarding/agent-setup.js';
import { Group, Row } from './settings-controls.js';
import s from './settings.module.css';

/** One ACP agent as the daemon lists it (src/ipc/acp-handlers.ts AcpAgentView). */
interface AgentView {
  readonly id: string;
  readonly label: string;
  readonly source: 'builtin' | 'registry' | 'local';
  readonly command: string;
  readonly args: readonly string[];
  readonly version?: string;
  readonly description?: string;
  readonly installed: boolean;
  readonly install?: string;
  readonly installCommand?: string;
}

/** One ACP Registry result (src/agent/runtime/acp/registry.ts RegistryHit). */
interface Hit {
  readonly id: string;
  readonly runtime: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly kind?: 'binary' | 'npx' | 'uvx';
  readonly installed?: string;
}

interface Draft {
  readonly label: string;
  readonly command: string;
  readonly args: string;
  readonly env: string;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Bad arguments for [\w.]+: /, '') : String(err));

/** Arguments as typed: split on spaces, "quoted words" kept together. */
export function splitArgs(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

/** Variables as typed, one NAME=value a line. */
export function parseEnv(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );
}

const SOURCE: Readonly<Record<AgentView['source'], string>> = { builtin: 'Built in', registry: 'From the ACP Registry', local: 'Your command' };
const KIND: Readonly<Record<NonNullable<Hit['kind']>, string>> = { binary: 'downloads its program', npx: 'runs through npx', uvx: 'runs through uvx' };
/** The built-in agents you could add, before Show All. */
const FIRST = 4;

/**
 * Settings › Agent › ACP agents: Antigravity and other Agent Client Protocol agents, each added by
 * you before it's in the agent pickers. What you added, with where it stands and its one fix; the
 * built-in ones you could add (Add when its CLI is here, its install command to copy when it isn't);
 * the ACP Registry, searched and installed from on your say; and a command of yours.
 */
export function AcpAgentsSettings() {
  const api = useApi();
  const runtimes = useApp((st) => st.runtimes);
  const [added, setAdded] = useState<readonly AgentView[] | undefined>(undefined);
  const [catalog, setCatalog] = useState<readonly AgentView[]>([]);
  const [all, setAll] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<readonly Hit[] | undefined>(undefined);
  const [confirm, setConfirm] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | undefined>(undefined);

  const load = async (): Promise<void> => {
    const [mine, more] = await Promise.all([api.acp.agents(), api.acp.catalog()]);
    setAdded((mine as { agents: AgentView[] }).agents);
    setCatalog((more as { agents: AgentView[] }).agents);
  };
  useEffect(() => {
    void load().catch(() => setAdded([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const run = async (what: string, work: () => Promise<unknown>): Promise<void> => {
    setBusy(what);
    setError('');
    try {
      const out = (await work()) as { ok?: boolean; error?: string } | undefined;
      if (out && out.ok === false && out.error) setError(out.error);
      await load();
      if (hits) setHits((await api.acp.search(query)) as Hit[]);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(undefined);
      setConfirm(undefined);
    }
  };

  const search = async (): Promise<void> => {
    setBusy('search');
    setError('');
    try {
      setHits((await api.acp.search(query.trim())) as Hit[]);
    } catch {
      setError('The ACP Registry can’t be reached right now. Your agents still work.');
    } finally {
      setBusy(undefined);
    }
  };

  /** Where an added agent stands here (what Check Again found), in the same words as Your agents. */
  const standing = (a: AgentView) => {
    const choice = runtimes.find((r) => r.id === a.id);
    const row = choice ? agentRows([{ ...choice, id: 'codex' }], true)[0] : undefined;
    // Not here: the words and its install command (when it has one) beside it say it all.
    if (!a.installed) return { tone: 'muted' as const, words: 'Not installed', detail: a.installCommand ? '' : (a.install ?? '') };
    if (choice?.state === 'signed_out') return { tone: 'warn' as const, words: row?.words ?? 'Signed out', detail: choice.fix ?? '', signIn: true };
    return { tone: 'ok' as const, words: row?.words ?? 'Ready', detail: a.description ?? '' };
  };

  const shownCatalog = all ? catalog : catalog.slice(0, FIRST);

  return (
    <Group title="ACP agents">
      <Row
        label="Agents that speak ACP"
        /* agent-wording: claude (friends’ tasks and guests go to the Claude runtime, by name) */
        detail="Antigravity, Cursor, Gemini CLI and any other Agent Client Protocol agent, each with its own sign-in and models. One you add here is in the agent box you type in. They can run some steps without asking, so friends’ tasks and guests stay with Claude."
      />
      {added === undefined ? <div className={s.note}>Looking…</div> : null}
      {added?.length === 0 ? <div className={s.note}>None added yet: add one below.</div> : null}
      {added?.map((a) => {
        const at = standing(a);
        const menu: ActionItem[] = [
          { label: 'Check Again', icon: 'refresh', onSelect: () => void run(a.id, () => api.workbench.checkAgents()) },
          { label: a.source === 'registry' ? 'Uninstall' : 'Remove', icon: 'trash', danger: true, separate: true, onSelect: () => void run(a.id, () => api.acp.remove(a.id)) },
        ];
        return (
          <div key={a.id} data-testid={`acp-agent-${a.id}`}>
            <Row name label={a.label} detail={`${SOURCE[a.source]}${a.version ? ` ${a.version}` : ''}${at.detail ? ` · ${at.detail}` : ''}`}>
              <Icon name={runtimeMark(a.id)} size={16} />
              <Dot tone={at.tone} />
              {at.words}
              {at.signIn ? (
                <Button size="small" onClick={() => void api.workbench.agentSignIn(a.id)}>
                  Sign In
                </Button>
              ) : null}
              {!a.installed && a.installCommand ? <CopyCommand className={s.agentCommand} command={a.installCommand} /> : null}
              <ActionsDropdown items={menu}>
                <IconButton icon="more" label={`More for ${a.label}`} />
              </ActionsDropdown>
            </Row>
          </div>
        );
      })}
      {catalog.length ? <Row label="Add an agent" detail="Beluga’s own list. Add one once its CLI is on this computer." /> : null}
      {shownCatalog.map((a) => (
        <Row key={a.id} name label={a.label} detail={a.installed ? `On ${thisComputer()}${a.description ? ` · ${a.description}` : ''}` : a.installCommand ? `Not on ${thisComputer()} yet` : (a.install ?? `Not on ${thisComputer()} yet`)}>
          {a.installed ? (
            <Button size="small" disabled={Boolean(busy)} onClick={() => void run(a.id, () => api.acp.add(a.id))}>
              {busy === a.id ? 'Adding…' : 'Add'}
            </Button>
          ) : a.installCommand ? (
            <CopyCommand className={s.agentCommand} command={a.installCommand} />
          ) : null}
        </Row>
      ))}
      {catalog.length > FIRST && !all ? (
        <Row label={`${catalog.length - FIRST} more`} detail={catalog.slice(FIRST).map((a) => a.label).join(', ')}>
          <Button variant="quiet" onClick={() => setAll(true)}>
            Show All
          </Button>
        </Row>
      ) : null}
      <Row label="ACP Registry" detail="The agents listed at agentclientprotocol.com. They’re other people’s code: look at an agent’s source and license before you install it.">
        <input
          className={s.text}
          aria-label="Search the ACP Registry"
          value={query}
          placeholder="Search"
          spellCheck={false}
          onChange={(ev) => setQuery(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') void search();
          }}
        />
        <Button variant="quiet" icon="refresh" disabled={Boolean(busy)} onClick={() => void search()}>
          {busy === 'search' ? 'Looking…' : hits ? 'Search' : 'Browse'}
        </Button>
      </Row>
      {error && !draft ? <div className={s.endpointError}>{error}</div> : null}
      {hits?.length === 0 ? <div className={s.note}>No agent in the Registry has those words.</div> : null}
      {hits?.map((h) => (
        <Row key={h.id} name label={`${h.name} ${h.version}`} detail={`${h.description ?? h.id}${h.kind ? ` · ${KIND[h.kind]}` : ` · doesn’t run on ${thisComputer()}`}${h.installed ? ` · installed ${h.installed}` : ''}`}>
          {confirm === h.id ? (
            <>
              <Button variant="quiet" onClick={() => setConfirm(undefined)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={Boolean(busy)} onClick={() => void run(h.id, () => api.acp.install(h.id))}>
                {busy === h.id ? 'Installing…' : h.kind === 'binary' ? 'Download and Install' : 'Install'}
              </Button>
            </>
          ) : (
            <Button variant="quiet" disabled={Boolean(busy) || !h.kind || h.installed === h.version} onClick={() => setConfirm(h.id)}>
              {h.installed ? (h.installed === h.version ? 'Installed' : 'Update') : 'Install…'}
            </Button>
          )}
        </Row>
      ))}
      <Row label="A command of yours" detail="Any program that speaks ACP over stdio, by its command, its arguments and its variables.">
        <Button
          icon="plus"
          disabled={Boolean(busy)}
          onClick={() => {
            setError('');
            setDraft({ label: '', command: '', args: 'acp', env: '' });
          }}
        >
          Add Command…
        </Button>
      </Row>
      {draft ? (
        <form
          className={s.endpointForm}
          onSubmit={(ev) => {
            ev.preventDefault();
            const env = parseEnv(draft.env);
            void run('add', () => api.acp.addCommand({ label: draft.label.trim(), command: draft.command.trim(), args: splitArgs(draft.args), ...(Object.keys(env).length ? { env } : {}) })).then(() => setDraft(undefined));
          }}
        >
          <label className={s.endpointField}>
            <span>Name</span>
            <input className={s.text} aria-label="Name" value={draft.label} placeholder="DeepSeek Harness" onChange={(ev) => setDraft({ ...draft, label: ev.target.value })} autoFocus />
          </label>
          <label className={s.endpointField}>
            <span>Command</span>
            <input className={s.text} aria-label="Command" value={draft.command} spellCheck={false} placeholder="dsh, or a full path" onChange={(ev) => setDraft({ ...draft, command: ev.target.value })} />
          </label>
          <label className={s.endpointField}>
            <span>Arguments</span>
            <input className={s.text} aria-label="Arguments" value={draft.args} spellCheck={false} placeholder="--profile acp" onChange={(ev) => setDraft({ ...draft, args: ev.target.value })} />
          </label>
          <label className={s.endpointField}>
            <span>Variables</span>
            <textarea className={s.text} aria-label="Variables" rows={2} value={draft.env} spellCheck={false} placeholder="NAME=value, one a line" onChange={(ev) => setDraft({ ...draft, env: ev.target.value })} />
          </label>
          {error ? <div className={s.endpointError}>{error}</div> : null}
          <div className={s.endpointBar}>
            <Button variant="quiet" onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={Boolean(busy) || !draft.label.trim() || !draft.command.trim()}>
              {busy === 'add' ? 'Adding…' : 'Add'}
            </Button>
          </div>
        </form>
      ) : null}
    </Group>
  );
}
