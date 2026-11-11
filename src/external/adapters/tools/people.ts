import { z } from 'zod';
import type { MessageVia } from '../../../protocol.js';
import type { Grant } from '../../domain/grant.js';
import type { MethodCalls } from '../../ports/methods.js';
import type { ExternalToolDef, Resolved } from '../mcp-tools.js';
import type { MethodRow, Scope } from './method-tool.js';

/**
 * Direct messages, groups and friends. Each needs grant.chats.dms or grant.chats.groups. What an
 * agent writes carries `via`, so a friend sees "Sent by <agent>"; an older Mac shows the words alone.
 */

const dms: Scope = { on: 'network', area: 'dms' };
const groups: Scope = { on: 'network', area: 'groups' };
const either: Scope = { on: 'network', area: 'either' };
const conversation: Scope = { on: 'conversation', arg: 'conversation' };
const TEXT_MAX = 8000;
const PEER = /^[\w-]{32}$/;
const GROUP = /^[0-9a-f]{32}$/;
const CONVERSATION = /^(dm:[\w-]{32}|group:[0-9a-f]{32})$/;

export const PEOPLE_ROWS: readonly MethodRow[] = [
  { name: 'network_status', method: 'network.status', params: [], scope: either, description: 'Whether the Beluga network is on, and your address on it.' },
  { name: 'friend_list', method: 'network.friends.list', params: [], scope: dms, description: 'Your friends.' },
  { name: 'friend_invite', method: 'network.friends.invite', params: [], scope: dms, description: 'Make a one-time friend invitation.' },
  { name: 'friend_accept', method: 'network.friends.accept', params: ['invitation'], scope: dms, description: 'Use a friend or group invitation.' },
  { name: 'friend_cancel_invite', method: 'network.friends.cancelInvite', params: ['invite'], scope: dms, description: 'Take back a friend invitation.' },
  { name: 'friend_remove', method: 'network.friends.remove', params: ['peer'], scope: dms, description: 'Remove a friend. A person is asked each time.' },
  { name: 'friend_add_from_room', method: 'network.friends.addFromRoom', params: ['peer'], scope: dms, description: 'Ask someone in your room to be friends.' },
  { name: 'friend_answer_offer', method: 'network.friends.answerOffer', params: ['peer', 'accept'], scope: dms, description: 'Answer a friend request from someone in your room.' },
  { name: 'dm_history', method: 'network.dm.history', params: ['peer', 'page'], scope: dms, description: 'A page of a direct conversation.' },
  { name: 'group_list', method: 'network.groups.list', params: [], scope: groups, description: 'Your groups.' },
  { name: 'group_create', method: 'network.groups.create', params: ['name', 'members'], scope: groups, description: 'Make a group.' },
  { name: 'group_history', method: 'network.groups.history', params: ['group', 'page'], scope: groups, description: 'A page of a group\'s messages.' },
  { name: 'group_add_member', method: 'network.groups.addMember', params: ['group', 'peer'], scope: groups, description: 'Add a member to a group.' },
  { name: 'group_remove_member', method: 'network.groups.removeMember', params: ['group', 'peer'], scope: groups, description: 'Remove a member from a group. A person is asked each time.' },
  { name: 'group_set_admin', method: 'network.groups.setAdmin', params: ['group', 'peer', 'admin'], scope: groups, description: 'Make a member an admin of a group, or not.' },
  { name: 'group_leave', method: 'network.groups.leave', params: ['group'], scope: groups, description: 'Leave a group. A person is asked each time.' },
  { name: 'group_delete', method: 'network.groups.delete', params: ['group'], scope: groups, description: 'Delete a group you left from this Mac. A person is asked each time.' },
  { name: 'group_rename', method: 'network.groups.rename', params: ['group', 'name'], scope: groups, description: 'Rename a group.' },
  { name: 'group_invite', method: 'network.groups.invite', params: ['group', 'options'], scope: groups, description: 'Make an invite link for a group.' },
  { name: 'group_join', method: 'network.groups.join', params: ['invitation'], scope: groups, description: 'Join a group with an invitation.' },
  { name: 'group_approve', method: 'network.groups.approve', params: ['group', 'peer'], scope: groups, description: 'Let someone who asked into a group.' },
  { name: 'group_decline', method: 'network.groups.decline', params: ['group', 'peer'], scope: groups, description: 'Decline someone who asked to join a group.' },
  { name: 'channel_main', method: 'network.channels.main', params: [], scope: groups, description: 'Your main channel, a group with all your friends.' },
  { name: 'presence_get', method: 'network.presence.get', params: [], scope: either, description: 'Your status on the network.' },
  { name: 'avatar_get', method: 'network.avatar.get', params: ['sha'], scope: either, description: 'A profile picture.' },
  { name: 'net_file_add', method: 'network.files.add', params: ['paths'], scope: either, description: 'Take files in to share in a conversation. A secret file is refused.' },
  { name: 'net_file_add_data', method: 'network.files.addData', params: ['name', 'base64', 'part'], scope: either, description: 'Take bytes in to share in a conversation.' },
  { name: 'net_file_download', method: 'network.files.download', params: ['sha', 'conversation'], scope: either, description: 'Get a file shared in a conversation.' },
  { name: 'net_file_cancel', method: 'network.files.cancel', params: ['sha'], scope: either, description: 'Stop getting a file.' },
  { name: 'net_file_save_to', method: 'network.files.saveTo', params: ['sha', 'target'], scope: either, description: 'Put a copy of a shared file in a place you name. A secret path is refused.' },
  { name: 'message_react', method: 'network.messages.react', params: ['conversation', 'message', 'emoji', 'on'], scope: { on: 'conversation', arg: 'conversation' }, description: 'Put an emoji on a message in a direct message or a group, or take yours off, with this agent\'s name. A person is asked below full.' },
  { name: 'calls_list', method: 'calls.list', params: [], scope: { on: 'network', area: 'either' }, description: 'The calls going on now, in chats this agent reaches.' },
  { name: 'net_file_preview', method: 'network.files.preview', params: ['sha'], scope: either, description: 'A shared picture\'s bytes.' },
  { name: 'message_delete', method: 'network.messages.delete', params: ['conversation', 'message', 'options'], scope: conversation, description: 'Delete a direct message. A person is asked each time.' },
  { name: 'message_edit', method: 'network.messages.edit', params: ['conversation', 'message', 'text'], scope: conversation, description: 'Change the words of a direct message you sent.' },
  { name: 'conversation_clear', method: 'network.clear', params: ['conversation'], scope: conversation, description: 'Empty a direct conversation on this Mac. A person is asked each time.' },
  { name: 'conversation_read', method: 'network.read', params: ['conversation'], scope: conversation, description: 'Mark a conversation read.' },
];

/** The tools that write as you, with this agent's name on each message. */
export function peopleTools(calls: MethodCalls): ExternalToolDef[] {
  const via = (grant: Grant): MessageVia => ({ id: grant.id, name: grant.name, creationSource: 'mcp' });
  const write = (to: string) => (args: Record<string, unknown>, grant: Grant) => calls.postAs(to, String(args.text), via(grant));
  const inArea = (conversationId: string, grant: Grant): Resolved => ({ target: conversationId.startsWith('dm:') ? 'dm' : 'group', inScope: conversationId.startsWith('dm:') ? grant.chats.dms : grant.chats.groups, detail: 'A message that a person reads, with this agent\'s name on it.' });
  const sent = (value: unknown) => ({ sent: true, ...(value && typeof value === 'object' && 'id' in value ? { id: (value as { id: string }).id } : {}) });
  const text = z.string().min(1).max(TEXT_MAX);
  return [
    {
      name: 'dm_send',
      description: 'Send a friend a direct message, as you, with this agent\'s name on it. It needs a grant with direct messages.',
      inputSchema: { peer: z.string().regex(PEER), text },
      resolve: (args, grant) => inArea(`dm:${String(args.peer)}`, grant),
      run: async (args, grant) => sent(await write(`dm:${String(args.peer)}`)(args, grant)),
    },
    {
      name: 'group_send',
      description: 'Write in a group, as you, with this agent\'s name on it. It needs a grant with groups.',
      inputSchema: { group: z.string().regex(GROUP), text },
      resolve: (args, grant) => inArea(`group:${String(args.group)}`, grant),
      run: async (args, grant) => sent(await write(`group:${String(args.group)}`)(args, grant)),
    },
    {
      name: 'conversation_post',
      description: 'Write in a conversation (dm:<peer> or group:<id>), with files you added and with whose agents should answer. This agent\'s name is on it.',
      inputSchema: { conversation: z.string().regex(CONVERSATION), text: z.string().max(TEXT_MAX), files: z.array(z.object({ sha: z.string().regex(/^[0-9a-f]{64}$/), name: z.string().min(1).max(200), size: z.number().int().min(0), mime: z.string().max(100).optional(), image: z.boolean().optional() })).max(20).optional(), ask: z.union([z.literal('all'), z.array(z.string().regex(PEER)).min(1).max(100)]).optional() },
      resolve: (args, grant) => inArea(String(args.conversation), grant),
      run: async (args, grant) => sent(await calls.postAs(String(args.conversation), String(args.text), via(grant), { ...(args.files ? { files: args.files } : {}), ...(args.ask ? { ask: args.ask } : {}) })),
    },
  ];
}
