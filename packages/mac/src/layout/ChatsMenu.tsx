import { ActionsDropdown, type ActionItem } from '../components/SpecMenu.js';
import { IconButton } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { showArchivedOf } from './ProjectTree.js';

/**
 * The Chats header's •••: archived chats stay out of the sidebar, so this is the way to them
 * (the Overview's Archived list, narrowed to Chats), as a project's own menu has Show Archived.
 */
export function ChatsMenu() {
  const actions = useActions();
  const chats = useApp((st) => {
    const p = st.projects.find((x) => !x.root);
    return p ? { id: p.id, archived: p.workspaces.filter((w) => w.archived).length } : undefined;
  }, sameDeep);
  if (!chats?.archived) return null;
  const items: ActionItem[] = [{ label: `Show Archived (${chats.archived})`, icon: 'archive', onSelect: () => showArchivedOf(actions.run, chats.id) }];
  return (
    <ActionsDropdown items={items}>
      <IconButton size="small" icon="more" label="Chats Options" />
    </ActionsDropdown>
  );
}
