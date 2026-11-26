import type { ComponentType } from 'react';
import type { MenuKind } from '@beluga/ui/menus.js';
// Inviting, people and sharing.
import { InviteSheet } from './InviteSheet.js';
import { PersonPopover } from './PersonPopover.js';
import { ShareFolderSheet } from './ShareFolderSheet.js';
import { SharedSheet } from './SharedSheet.js';
import { InvitePersonSheet, WorkspaceShareSheet } from './WorkspaceShare.js';
// Confirmations and workspace forms.
import { AgentsAlert } from './AgentsAlert.js';
import { ArchivedSheet, InboxRedirect, ModelSheet, WelcomeSheet } from './ChoiceSheets.js';
import { ClearAlert } from './ClearAlert.js';
import { ConfirmAlert } from './ConfirmAlert.js';
import { ProjectSettingsSheet } from './ProjectSettingsSheet.js';
import { PullRequestSheet } from './PullRequestSheet.js';
import { RemoteWorktreeSheet } from './RemoteWorktreeSheet.js';
import { TemplatesSheet } from './TemplatesSheet.js';

/**
 * Menus the Mac app shows its own way: a confirmation is an alert, an invite is a form, a person is a popover… A menu kind
 * listed here is drawn by its component instead of the generic list sheet (MenuSheet), with
 * the same menu spec and actions underneath where that fits.
 */
export interface NativeMenuProps<K extends MenuKind['kind'] = MenuKind['kind']> {
  readonly menu: Extract<MenuKind, { kind: K }>;
  /** Close it (what Esc and Cancel do). */
  readonly close: () => void;
}

export type NativeMenus = { readonly [K in MenuKind['kind']]?: ComponentType<NativeMenuProps<K>> };

export const NATIVE_MENUS: NativeMenus = {
  // Inviting, people and sharing.
  invite_link: InviteSheet,
  person: PersonPopover,
  ws_share: WorkspaceShareSheet,
  invite_person: InvitePersonSheet,
  share_folder: ShareFolderSheet,
  share_who: ShareFolderSheet,
  shared: SharedSheet,
  // Confirmations and workspace forms.
  confirm: ConfirmAlert,
  clear: ClearAlert,
  agents: AgentsAlert,
  scripts: ProjectSettingsSheet,
  pr: PullRequestSheet,
  templates: TemplatesSheet,
  remote_ws: RemoteWorktreeSheet,
  model: ModelSheet,
  welcome: WelcomeSheet,
  inbox: InboxRedirect,
  archived: ArchivedSheet,
};
