import type { ComponentType } from 'react';
import { Platform } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { AGENT_MARKS, AGENT_MARK_VIEWBOX, type AgentMark, runtimeMark } from '../../../src/shared/agent-marks';
import { color as palette } from '../lib/theme';

export type { AgentMark };
export { agentMark, modelMark, runtimeMark } from '../../../src/shared/agent-marks';

/**
 * An agent's or a model maker's mark (BLG-497): Claude Code, Codex, a local model, Anthropic,
 * OpenAI. The makers' own logos, the same data as the Mac (src/shared/agent-marks.ts): filled, in
 * the brand's colour when it has one (Claude Code's orange), else the ink it's given (the text's,
 * by default). Always beside the agent's name, never instead of it.
 */
/** Hidden from screen readers (the name beside it says it): the phone's own props, or the web's `aria-hidden` (react-native-svg hands props to the DOM `<svg>` as they are). */
const HIDDEN = Platform.OS === 'web' ? { 'aria-hidden': true } : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };

/** `muted`: in `color` (or the quiet text tone), not the maker's own color: the marks of child threads (BLG-345). */
export function AgentMarkIcon({ mark, size = 16, color, muted }: { readonly mark: AgentMark; readonly size?: number; readonly color?: string; readonly muted?: boolean }) {
  return (
    <Svg width={size} height={size} viewBox={AGENT_MARK_VIEWBOX} {...HIDDEN}>
      <Path d={AGENT_MARKS[mark].d} fill={muted ? (color ?? palette.text3) : (AGENT_MARKS[mark].color ?? color ?? palette.text)} {...(AGENT_MARKS[mark].evenOdd ? { fillRule: 'evenodd' as const, clipRule: 'evenodd' as const } : {})} />
    </Svg>
  );
}

/** What an icon slot takes (a lucide icon, or a mark below): its ink and size. */
export type IconLike = ComponentType<{ color?: string; size?: number; strokeWidth?: number | string }>;

const ICONS = new Map<AgentMark, IconLike>();

/** A mark as an icon slot's component (Options rows, IconBadge), made once per mark. */
export function markIcon(mark: AgentMark): IconLike {
  let Icon = ICONS.get(mark);
  if (!Icon) {
    const Made = ({ color, size }: { color?: string; size?: number }) => <AgentMarkIcon mark={mark} {...(size !== undefined ? { size } : {})} {...(color !== undefined ? { color } : {})} />;
    Made.displayName = `AgentMark(${mark})`;
    Icon = Made;
    ICONS.set(mark, Icon);
  }
  return Icon;
}

/**
 * An agent's mark when all the phone has is its name ("Your Codex", "mia's Claude", "Codex"):
 * the name says Codex, OpenCode or Claude, else `fallback` (a runtime, when known), else a local model's.
 * Only where the Mac sends no agent ref.
 */
export function markOfName(name: string, fallback?: string): AgentMark {
  if (/\bcodex\b/i.test(name)) return 'codex';
  if (/\bopencode\b/i.test(name)) return 'opencode';
  if (/\bgrok\b/i.test(name)) return 'grok';
  if (/\bclaude\b/i.test(name)) return 'claudeCode';
  if (/\blocal model\b/i.test(name)) return 'localModel';
  return fallback !== undefined ? runtimeMark(fallback) : 'localModel';
}

/**
 * Whether a task's activity line is an agent's (the board names it "Your Claude", "mia's Codex"):
 * a person is "You" or their name, Beluga is "Beluga". Only for an older Mac's lines: a newer one
 * sends the line's `agent` (BLG-498).
 */
export function isAgentActor(who: string): boolean {
  return /^your\s/i.test(who) || /['’]s\s\S/.test(who);
}
