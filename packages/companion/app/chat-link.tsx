import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import type { ChatResolveResult } from '../../../src/companion/calls';
import { type ChatRef, chatLinkAnswer, parseChatRef } from '../../../src/shared/chat-ref';
import { useLink } from '../lib/hooks';
import { calls } from '../lib/link/calls';
import { store } from '../lib/store';
import { color } from '../lib/theme';

/** How long a link waits for your Mac before it says so. */
const WAIT_MS = 8000;

/**
 * Where a chat's link lands (app/+native-intent.tsx): it asks the Mac what the chat is now, then
 * opens /conv/<channel> in its place, where the Mac's phoneChannel reads it. A chat on another
 * computer or one that's gone says so and goes back. With chat links off, it just goes back.
 */
export default function ChatLink() {
  const { ref = '' } = useLocalSearchParams<{ ref: string }>();
  const { phase } = useLink();
  useEffect(() => {
    const target = refOf(ref);
    if (!target) return leave();
    if (phase !== 'open') {
      const timer = setTimeout(() => leave('Your Mac is away.'), WAIT_MS);
      return () => clearTimeout(timer);
    }
    if (!store.supports('chatLinks')) return leave();
    let alive = true;
    store.call<ChatResolveResult>(calls.resolveChat(`${target.owner}/${target.channel}`), { queue: false }).then(
      (chat) => {
        if (!alive) return;
        const answer = chatLinkAnswer(chat);
        if (answer.opens) router.replace(`/conv/${encodeURIComponent(target.channel)}`);
        else leave(answer.say);
      },
      () => alive && leave('Your Mac is away.'),
    );
    return () => {
      alive = false;
    };
  }, [phase, ref]);
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: color.bg }}>
      <ActivityIndicator color={color.text2} />
    </View>
  );
}

/** The ref in the route: read as it came, or decoded when the router left it encoded. */
function refOf(text: string): ChatRef | undefined {
  try {
    return parseChatRef(text) ?? parseChatRef(decodeURIComponent(text));
  } catch {
    return undefined;
  }
}

function leave(say?: string): void {
  if (say) store.toast({ text: say, tone: 'info' });
  if (router.canGoBack()) router.back();
  else router.replace('/');
}
