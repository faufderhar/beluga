import { CHAT_LINK_PREFIX, chatLinkOf, formatChatRef } from '../../../src/shared/chat-ref';
import { DEVICE_LINK } from '../lib/link/protocol';

/**
 * A pairing link opened on the phone (`beluga://device#…`): the Mac sends one over the USB cable to
 * pair a plugged-in phone (BLG-190), as if its QR had been scanned. It goes to the pairing screen,
 * which shows the four pictures to check as ever. A chat's link (`beluga://chat/…`) goes to
 * /chat-link, which asks the Mac what that chat is before it opens /conv/<channel>; a malformed one
 * goes nowhere. Anything else opens as it would.
 */
export function redirectSystemPath({ path }: { path: string | null; initial: boolean }): string | null {
  if (path && DEVICE_LINK.test(path)) return `/pair?link=${encodeURIComponent(path)}`;
  if (path?.startsWith(CHAT_LINK_PREFIX)) {
    const ref = chatLinkOf(path);
    return ref ? `/chat-link?ref=${encodeURIComponent(formatChatRef(ref)!)}` : null;
  }
  return path;
}
