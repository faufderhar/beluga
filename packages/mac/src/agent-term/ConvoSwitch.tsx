import { Segmented } from '../components/ui.js';
import { type ConvoMode, convoModeOf, withConvoMode } from '../lib/convo-mode.js';
import { getPrefs, setPrefs, usePrefs } from '../lib/prefs.js';
import { shortcutKeys } from '../lib/shortcuts.js';
import { useTerminalCapable } from './ConvoCenter.js';

/** Room the switch takes in the header, with words and as icons only. */
export const SWITCH_W = 236;
export const SWITCH_ICONS_W = 104;

/** Show a conversation as the chat, its agent's terminal, or both (BLG-534). */
export function setConvoMode(wsId: string, mode: ConvoMode): void {
  setPrefs({ convoModes: withConvoMode(getPrefs().convoModes, wsId, mode) });
}

/** The header's Chat · Terminal · Both, for a conversation that can have a terminal. */
export function ConvoSwitch({ wsId, iconOnly }: { readonly wsId: string; readonly iconOnly?: boolean }) {
  const prefs = usePrefs();
  const capable = useTerminalCapable(wsId);
  // Only for people who turned the terminal view on (Settings › Terminal): everyone else has the chat.
  if (!capable || !prefs.termView) return null;
  const mode = convoModeOf(prefs.convoModes, prefs.convoDefault, wsId);
  return (
    <Segmented size="large"
      label="Show the conversation as"
      value={mode}
      iconOnly={iconOnly}
      onChange={(m) => setConvoMode(wsId, m)}
      options={[
        { value: 'chat', label: 'Chat', icon: 'chat', hint: 'The conversation, drawn: graphs, tables, tasks' },
        { value: 'terminal', label: 'Terminal', icon: 'terminal', hint: 'Your agent’s own terminal, on the same conversation', ...(shortcutKeys('conv-terminal') ? { keys: shortcutKeys('conv-terminal')! } : {}) },
        { value: 'both', label: 'Both', icon: 'columns', hint: 'The terminal, with the chat beside it' },
      ]}
    />
  );
}
