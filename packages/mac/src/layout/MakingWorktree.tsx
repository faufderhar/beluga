import { useEffect, useMemo, useRef } from 'react';
import type { LogItem } from '@beluga/core/store.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { Empty } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { askedAhead } from '../lib/make-ahead.js';
import { ChatLog } from '../chat/ChatLog.js';
import { expectClaude } from '../chat/flight.js';
import views from '../views/views.module.css';
import s from './Shell.module.css';
import side from './Sidebar.module.css';

/** Your first message to a worktree being made, as its chat row, while only this window knows it. */
export function aheadMessage(wsId: string, selfId: string, text: string, ts: number): LogItem {
  return { id: `ahead:${wsId}`, type: 'chat', channel: `ws:${wsId}`, from: selfId, name: '', text, ts, byAgent: false };
}

/**
 * A worktree being made: its page is its conversation at once (BLG-531, BLG-942). What you asked
 * shows as your message and "Claude is starting…" under it, as in any chat you send in, while git
 * makes the folder; the agent gets it when that's done, and the page is the worktree's then. A fork,
 * or one made with only a name, says what's happening instead (no message, nobody starting).
 */
export function MakingWorktree() {
  const ws = useApp((st) => (st.view.kind === 'workspace' ? findWorkspace(st.projects, st.view.id) : undefined));
  const parent = useApp((st) => (ws?.forkedFrom ? findWorkspace(st.projects, ws.forkedFrom)?.name : undefined));
  const selfId = useApp((st) => st.selfId);
  const channel = ws ? `ws:${ws.id}` : '';
  const asked = useApp((st) => (channel ? st.log.some((l) => l.channel === channel) : false));
  const words = ws ? askedAhead(ws.id) : undefined;
  // A fork (BLG-921): a copy of another worktree, its conversation shown already.
  const fork = ws?.forkedFrom ? (parent ?? 'its parent') : undefined;
  const talking = Boolean(ws && !fork && (asked || words));
  const wsId = ws?.id;
  const createdAt = ws?.createdAt ?? 0;
  const ahead = useMemo(() => (wsId && words && !asked ? [aheadMessage(wsId, selfId, words, createdAt)] : undefined), [wsId, words, asked, selfId, createdAt]);
  useStartingCarriesOn(channel, talking);
  if (!ws) return null;
  const from = ws.base ?? 'the latest origin';
  if (talking) {
    return (
      <div className={views.chat}>
        <ChatLog key={ws.id} channel={channel} ahead={ahead} starting />
      </div>
    );
  }
  if (!fork || !asked) {
    return (
      <Empty
        icon="branch"
        mark={<span className={side.making} style={{ width: 18, height: 18 }} aria-hidden="true" />}
        title={fork ? `Forking ${fork}…` : `Making ${ws.name}…`}
        detail={fork ? `${ws.name} gets a copy of its commits, uncommitted changes, Scratch and conversation. It opens here in a moment.` : `A new worktree from ${from}. Its conversation opens here in a moment; anything you asked your agent starts then.`}
      />
    );
  }
  return (
    <div className={views.chat}>
      <ChatLog key={ws.id} channel={channel} />
      <div className={s.makingLine} role="status">
        <span className={side.making} aria-hidden="true" />
        {`Forking ${fork} into ${ws.name}: copying its changes, Scratch and conversation. You can write here in a moment.`}
      </div>
    </div>
  );
}

/**
 * The worktree is made and its page becomes its conversation: "Claude is starting…" stays under your
 * message there until Claude's card shows (flight.ts), instead of blinking off in between.
 */
function useStartingCarriesOn(channel: string, talking: boolean): void {
  const was = useRef(talking);
  was.current = talking;
  useEffect(
    () => () => {
      if (channel && was.current) expectClaude(channel, 0, undefined);
    },
    [channel],
  );
}
