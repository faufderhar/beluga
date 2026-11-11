/**
 * The room's group chat is there to open: someone besides you is in the room (`peers` counts
 * you too). Alone, it's no place of its own (BLG-871): your agent is a new chat away.
 */
export const groupChatOpen = (state: { readonly peers: ReadonlyArray<unknown> }): boolean => state.peers.length > 1;
