import { useEffect, useState } from 'react';
import { Button, Tip } from '../components/ui.js';
import { Icon } from '../components/Icon.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { useApi, useApp } from '../lib/beluga.js';
import s from './pr-strip.module.css';

const LEVEL_WORDS: Readonly<Record<string, string>> = { ask: 'asks you', trusted: 'trusted', full: 'full trust' };

/**
 * Above a chat an external agent started: which agent drives it and at what level. Stop ends all
 * the agent has going. Revoke also ends its grant. A level of nothing: its grant is gone.
 */
export function DrivenStrip({ workspaceId }: { workspaceId: string }) {
  const api = useApi();
  const agent = useApp((st) => findWorkspace(st.projects, workspaceId)?.startedByAgent);
  const running = useApp((st) => st.log.some((l) => l.type === 'agent' && l.channel === `ws:${workspaceId}` && !['done', 'error', 'denied', 'interrupted'].includes(l.status)));
  const [level, setLevel] = useState<string | undefined>();
  const id = agent?.id;
  useEffect(() => {
    if (!id) return;
    void api.external.agents().then((list) => setLevel((list as ReadonlyArray<{ id: string; level: string }>).find((a) => a.id === id)?.level), () => undefined);
  }, [api, id]);
  if (!agent) return null;
  return (
    <div className={s.strip} data-driven-strip={agent.id}>
      <div className={s.row}>
        <span className={s.main}>
          <Icon name="plug" size={13} />
          <span className={s.title}>
            Driven by {agent.name} · {level ? (LEVEL_WORDS[level] ?? level) : 'no longer connected'}
          </span>
        </span>
        <Tip label={`Stop all that ${agent.name} has going`}>
          <Button size="small" disabled={!running} onClick={() => void api.external.stopAgent(agent.id)}>Stop</Button>
        </Tip>
        {level ? (
          <Tip label={`End ${agent.name}'s access to this Beluga`}>
            <Button size="small" tone="error" onClick={() => void api.external.revoke(agent.id).then(() => setLevel(undefined))}>Revoke</Button>
          </Tip>
        ) : null}
      </div>
    </div>
  );
}
