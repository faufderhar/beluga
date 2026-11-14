import { ASSISTANT_CHANNEL, ASSISTANT_TITLE, activeAssistantChannel } from '@beluga/shared/assistant.js';
import { Icon } from '../components/Icon.js';
import { ActionsContext } from '../components/SpecMenu.js';
import { chatLinkItems } from '../lib/chat-links.js';
import { useActions } from '../lib/actions.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { type Signal, signalOf } from './attention-model.js';
import { SignalMark } from './signal-marks.js';
import { Row } from './sidebar-parts.js';
import { yourComputer } from '../lib/os-words.js';

const RANK: Record<Signal['level'], number> = { needs: 3, unread: 2, working: 1, idle: 0 };

/**
 * The sidebar's top row: "Your Mac" (core/assistant), your Claude for the whole Mac, not one
 * project. Its chats are tabs on its page (BLG-102); the row shows what matters most among them
 * (one waiting for you, then news, then working). The open one is the phone's Ask your Mac.
 */
export function AssistantNav() {
  const actions = useActions();
  // The phone is the Phone tab in this page's panel, not a row of its own (BLG-292); its full-size mirror is still yours.
  const selected = useApp((s) => s.view.kind === 'assistant' || s.view.kind === 'phone');
  const signal = useApp((s) => {
    // A sentinel run's chats are Sentinel's (Unread names the sentinel when one needs you).
    const own = s.assistant.chats.filter((c) => !c.auto);
    const channels = own.length ? own.map((c) => c.channel) : [ASSISTANT_CHANNEL];
    return channels.map((c) => signalOf(s, c)).reduce((a, b) => (RANK[b.level] > RANK[a.level] ? b : a));
  }, sameDeep);
  const { client } = useBeluga();
  const open = useApp((s) => activeAssistantChannel(s.assistant));
  const row = (
    <Row
      data-chat-row={open}
      icon={<Icon name="laptop" size={14} />}
      label={ASSISTANT_TITLE}
      detail={signal.tip || `Ask ${yourComputer()} anything: screenshots, what’s running, start a worktree or a task. Several chats as tabs; the open one is on your phone too`}
      selected={selected}
      onClick={() => actions.run({ type: 'view', view: { kind: 'assistant' } })}
      trailing={<SignalMark signal={signal} />}
    />
  );
  // The row is Your Mac; its link is the chat open now. Each tab has its own too (AssistantTabs).
  return (
    <ActionsContext
      items={() => {
        const state = client.store.getState();
        return chatLinkItems(state, client, activeAssistantChannel(state.assistant));
      }}
    >
      {row}
    </ActionsContext>
  );
}
