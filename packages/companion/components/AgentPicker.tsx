import { Check, Search } from 'lucide-react-native';
import { useState } from 'react';
import { Platform, ScrollView, TextInput, View } from 'react-native';
import { SEARCH_MODELS_OVER, searchModels } from '../../../src/shared/model-search';
import { calls } from '../lib/link/calls';
import type { AgentPickerView, Topic } from '../lib/link/protocol';
import { store } from '../lib/store';
import { useOn } from '../lib/scope';
import { color, radius } from '../lib/theme';
import { AgentMarkIcon, modelMark, runtimeMark } from './AgentMark';
import { Sheet } from './Sheet';
import { haptic, Press, T } from './ui';

type Group = AgentPickerView['groups'][number];

/**
 * The agent picker (BLG-446), as the Mac's composer has it: runtimes as groups with their models,
 * your default agent's first; one your Mac doesn't run is greyed with what's missing. A model of
 * the same runtime is a model change; another runtime is this worktree's new agent. Each group
 * leads with its runtime's mark (BLG-497); a model leads with its maker's only when that isn't the
 * runtime's own (a local runtime running an OpenAI model).
 */
export function AgentPickerSheet({ topic, picker, visible, onClose }: { readonly topic: Topic; readonly picker: AgentPickerView | undefined; readonly visible: boolean; readonly onClose: () => void }) {
  const on = useOn();
  const pick = (g: Group, value: string, label: string): void => {
    if (!picker) return;
    const call =
      g.runtime === picker.runtime
        ? calls.setModel(topic, value, label)
        : calls.setAgent(topic, g.isDefault && !value ? null : { runtime: g.runtime, label: g.label, ...(value ? { model: value } : {}) }, `${g.label} ${label}`);
    void store.call(call, on ? { on } : {}).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }));
  };
  return <AgentChoiceSheet title="Agent" caption="For this conversation, from your next message" picker={picker} visible={visible} onClose={onClose} onPick={pick} />;
}

/** The agent a picked row stands for (BLG-498): its runtime, and its model unless it's the runtime's own default. */
export const agentOfRow = (g: Pick<Group, 'runtime' | 'label'>, value: string): { runtime: string; label: string; model?: string } => ({ runtime: g.runtime, label: g.label, ...(value ? { model: value } : {}) });

/**
 * The same list for whatever an agent is picked for (BLG-498: a task, a plan's work): `yours`
 * adds "Your agent" on top (null: whatever your default is when the work starts), on when nothing
 * else is picked.
 */
export function AgentChoiceSheet({ title, caption, picker, visible, onClose, onPick, yours }: { readonly title: string; readonly caption: string; readonly picker: AgentPickerView | undefined; readonly visible: boolean; readonly onClose: () => void; readonly onPick: (g: Group, value: string, label: string) => void; readonly yours?: { readonly on: boolean; readonly onPick: () => void } }) {
  const pick = (g: Group, value: string, label: string): void => {
    if (!picker) return;
    haptic.commit();
    onPick(g, value, label);
    onClose();
  };
  const def = picker?.groups.find((g) => g.isDefault);
  // A long list (OpenCode with every provider, BLG-945): a search field, each group showing what matches.
  const [query, setQuery] = useState('');
  const searchable = Boolean(picker?.groups.some((g) => g.models.length + (g.more ?? 0) > SEARCH_MODELS_OVER));
  const searching = searchable && query.trim() !== '';
  const groups = (picker?.groups ?? []).map((g) => ({ g, models: searching ? searchModels(g.models, query, g.runtime) : g.models })).filter((x) => !searching || x.models.length);
  return (
    <Sheet
      visible={visible && Boolean(picker)}
      onDismiss={onClose}
      header={
        <View style={{ paddingHorizontal: 20, paddingBottom: 10 }}>
          <T v="title" style={{ fontSize: 20 }}>
            {title}
          </T>
          <T v="caption">{caption}</T>
          {searchable ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, paddingHorizontal: 12, height: 38, borderRadius: radius.m, backgroundColor: color.card }}>
              <Search size={16} color={color.text3} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search models"
                placeholderTextColor={color.text3}
                autoCorrect={false}
                autoCapitalize="none"
                clearButtonMode="while-editing"
                returnKeyType="search"
                accessibilityLabel="Search models"
                style={{ flex: 1, color: color.text, fontSize: 16, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) }}
              />
            </View>
          ) : null}
        </View>
      }
    >
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24, gap: 18 }}>
        {yours ? (
          <Press
            scaleTo={0.985}
            onPress={() => {
              haptic.commit();
              yours.onPick();
              onClose();
            }}
            accessibilityRole="radio"
            accessibilityState={{ checked: yours.on }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 14, backgroundColor: yours.on ? color.card : 'transparent' }}>
              <AgentMarkIcon mark={runtimeMark(def?.runtime)} size={18} color={color.text2} />
              <View style={{ flex: 1 }}>
                <T v="body">{def ? `Your agent (${def.label})` : 'Your agent'}</T>
                <T v="caption">Whatever your default agent is when the work starts</T>
              </View>
              {yours.on ? <Check size={18} color={color.text} /> : null}
            </View>
          </Press>
        ) : null}
        {searching && !groups.length ? <T v="caption">{`No model matches “${query.trim()}”.`}</T> : null}
        {groups.map(({ g, models }) => (
          <View key={g.runtime} style={{ gap: 4, opacity: g.available ? 1 : 0.55 }} accessibilityState={{ disabled: !g.available }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <AgentMarkIcon mark={runtimeMark(g.runtime)} size={18} color={color.text2} />
              <T v="heading" style={{ flexShrink: 1 }}>
                {g.isDefault ? `${g.label} · your default` : g.label}
              </T>
            </View>
            {g.available ? (
              models.map((m) => {
                const maker = m.value ? modelMark(m.value, g.runtime) : undefined;
                const other = maker && maker !== modelMark(undefined, g.runtime) ? maker : undefined;
                return (
                  <Press key={m.value || 'default'} scaleTo={0.985} onPress={() => pick(g, m.value, m.label)} accessibilityRole="radio" accessibilityState={{ checked: m.on }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 14, backgroundColor: m.on ? color.card : 'transparent' }}>
                      {other ? <AgentMarkIcon mark={other} size={16} color={color.text2} /> : null}
                      <View style={{ flex: 1 }}>
                        <T v="body">{m.label}</T>
                        {m.description ? <T v="caption">{m.description}</T> : null}
                      </View>
                      {m.on ? <Check size={18} color={color.text} /> : null}
                    </View>
                  </Press>
                );
              })
            ) : (
              <T v="caption">{g.why}</T>
            )}
            {g.available && g.more ? (
              <T v="caption" style={{ paddingHorizontal: 12 }}>
                {`${g.more} more on your Mac: pick them in its agent picker.`}
              </T>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </Sheet>
  );
}
