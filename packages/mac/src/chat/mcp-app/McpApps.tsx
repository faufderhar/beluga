import { memo, useMemo } from 'react';
import type { LogItem } from '@beluga/core/store.js';
import { mayHaveApps } from '@beluga/shared/mcp-apps.js';
import { useApp } from '../../lib/beluga.js';
import { useAgentSteps } from '../steps/use-steps.js';
import { AppFrame } from './AppFrame.js';

type AgentItem = Extract<LogItem, { type: 'agent' }>;

/**
 * The MCP Apps of a Claude card: each step of a tool with an
 * app draws the server's page here, under the steps, so it stays in sight when they fold away.
 * Only your own Claude's work has them (a Claude Code without MCP Apps records none).
 */
export function McpApps({ item, running }: { item: AgentItem; running: boolean }) {
  const mine = useApp((st) => st.selfId === item.owner);
  // A card with no MCP step reads nothing more: its steps are polled once already (AgentSteps).
  if (!mine || !mayHaveApps(item.steps)) return null;
  return <AppList item={item} running={running} />;
}

const AppList = memo(function AppList({ item, running }: { item: AgentItem; running: boolean }) {
  const change = `${item.status}:${item.steps.length}:${item.steps.at(-1) ?? ''}`;
  const { steps } = useAgentSteps(item.channel, item.id, running, change);
  // "id:done id:done": the same string while no app step starts or ends, so the frames aren't drawn again.
  const apps = (steps ?? []).filter((x) => x.hasApp).map((x) => `${x.id}:${x.status === 'running' ? 0 : 1}`).join(' ');
  const list = useMemo(() => (apps ? apps.split(' ').map((x) => ({ id: x.slice(0, x.lastIndexOf(':')), done: x.endsWith(':1') })) : []), [apps]);
  if (!list.length) return null;
  return (
    <>
      {list.map((a) => (
        <AppFrame key={a.id} channel={item.channel} itemId={item.id} stepId={a.id} done={a.done} />
      ))}
    </>
  );
});
