import { ActionsDropdown, type ActionItem } from '../components/SpecMenu.js';
import { IconButton } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { APP_MENU, type AppMenuRow, appearanceOf } from '../lib/app-menu-model.js';
import { inApp } from '../lib/boot.js';
import { useBeluga } from '../lib/beluga.js';
import { runMenuItem } from '../lib/native.js';
import { usePrefs } from '../lib/prefs.js';
import { useShortcutKeys } from '../lib/shortcuts.js';

/**
 * The menu bar in a browser (lib/app-menu-model.ts): one button where the Mac's traffic lights
 * would be, Settings first. The app has its menu bar, so there it shows nothing.
 */
export function AppMenu() {
  const { client, ui } = useBeluga();
  const actions = useActions();
  const keysOf = useShortcutKeys();
  const { appearance } = usePrefs();
  if (inApp()) return null;
  const toItem = (r: AppMenuRow): ActionItem => {
    const picks = appearanceOf(r.id);
    const keys = r.id ? keysOf(r.id) : undefined;
    return {
      label: r.label,
      ...(r.separate ? { separate: true } : {}),
      ...(keys ? { keys } : {}),
      ...(picks ? { checked: picks === appearance } : {}),
      ...(r.submenu ? { submenu: r.submenu.map(toItem) } : {}),
      onSelect: () => (r.id ? runMenuItem(r.id, client, ui, actions) : undefined),
    };
  };
  return (
    <ActionsDropdown items={APP_MENU.map(toItem)} align="start">
      <IconButton size="large" icon="gear" label="Settings and menus" />
    </ActionsDropdown>
  );
}
