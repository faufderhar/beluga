import { useFocusEffect } from 'expo-router';
import { Cable } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Header, Screen, useScrolled } from '../components/Screen';
import { Segments } from '../components/Segments';
import { Button, Card, haptic, Row, T } from '../components/ui';
import { calls } from '../lib/link/calls';
import { store } from '../lib/store';

interface Agent {
  readonly id: string;
  readonly name: string;
  readonly level: string;
  readonly route?: string;
  readonly suspendedAt?: number;
}
type Kind = 'allowed' | 'asked' | 'refused';
interface Activity {
  readonly ts: number;
  readonly agent: string;
  readonly tool: string;
  readonly target: string;
  readonly decidedBy: string;
  readonly argsHash: string;
  readonly kind: Kind;
}

const LEVEL_WORDS: Readonly<Record<string, string>> = { ask: 'Asks you each time', trusted: 'Trusted', full: 'Full trust' };
const KIND_WORDS: Readonly<Record<Kind, string>> = { allowed: 'Allowed', asked: 'Asked', refused: 'Refused' };
const SHOWN: ReadonlyArray<{ key: Kind | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'allowed', label: 'Allowed' },
  { key: 'asked', label: 'Asked' },
  { key: 'refused', label: 'Refused' },
];

/** Settings › External agents (BLG-122): who holds a grant, stopping or revoking them, and what they did with who decided. */
export default function Agents() {
  const { scrolled, onScroll } = useScrolled();
  const insets = useSafeAreaInsets();
  const [agents, setAgents] = useState<readonly Agent[]>([]);
  const [activity, setActivity] = useState<readonly Activity[]>([]);
  const [shown, setShown] = useState<Kind | 'all'>('all');

  const look = useCallback((kind: Kind | 'all') => {
    void store.call<readonly Agent[]>(calls.externalAgents(), { queue: false }).then((a) => setAgents(a ?? []), () => undefined);
    void store.call<readonly Activity[]>(calls.externalActivity(kind === 'all' ? undefined : kind), { queue: false }).then((a) => setActivity(a ?? []), () => undefined);
  }, []);
  useFocusEffect(useCallback(() => look(shown), [look, shown]));

  const act = (call: ReturnType<typeof calls.externalStopAll>, done: string): void => {
    haptic.commit();
    void store.call(call, { queue: false }).then(
      () => {
        store.toast({ text: done, tone: 'ok' });
        look(shown);
      },
      (err: unknown) => store.toast({ text: err instanceof Error ? err.message : 'It did not reach your Mac.', tone: 'error' }),
    );
  };

  return (
    <Screen>
      <Header scrolled={scrolled} back title="External agents" />
      <ScrollView onScroll={onScroll} scrollEventThrottle={32} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: insets.bottom + 40, gap: 12 }}>
        {agents.length ? <Button label="Stop all agents" onPress={() => act(calls.externalStopAll(), 'Stopped')} /> : <T v="caption">No external agent holds a grant.</T>}
        {agents.map((a) => (
          <Card key={a.id} style={{ gap: 10 }}>
            <Row first Icon={Cable} tone="lavender" label={a.name} sub={`${a.suspendedAt === undefined ? '' : 'Suspended · '}${a.route === 'remote' && a.level === 'full' ? '⚠ Full trust from outside this Mac' : (LEVEL_WORDS[a.level] ?? a.level)}`} chevron={false} />
            <View style={{ flexDirection: 'row', gap: 8, padding: 12, paddingTop: 0 }}>
              <Button flex={1} quiet label="Stop" onPress={() => act(calls.externalStop(a.id, a.name), `Stopped ${a.name}`)} />
              <Button flex={1} quiet label="Revoke" onPress={() => act(calls.externalRevoke(a.id, a.name), `Revoked ${a.name}`)} />
            </View>
          </Card>
        ))}
        <T v="callout" style={{ fontWeight: '700', marginTop: 8 }}>
          Activity
        </T>
        <Segments value={shown} options={SHOWN} onChange={setShown} />
        {activity.length ? (
          <Card>
            {activity.map((a, i) => (
              <Row key={`${a.ts} ${a.tool} ${a.argsHash}`} first={i === 0} label={`${a.agent}: ${a.tool}`} sub={`${KIND_WORDS[a.kind]} · decided by ${a.decidedBy === 'person' ? 'you' : 'its level'}${a.target ? ` · ${a.target}` : ''}`} chevron={false} />
            ))}
          </Card>
        ) : (
          <T v="caption">Nothing here yet.</T>
        )}
      </ScrollView>
    </Screen>
  );
}
