import { router } from 'expo-router';
import { ArrowUp, Bot, Check, ChevronRight, CircleAlert, Hourglass, ImageIcon, Images, MessageSquare } from 'lucide-react-native';
import { ProjectMark } from './ProjectMark';
import { Fragment, type ReactNode, useMemo, useState } from 'react';
import { Image } from 'expo-image';
import { ActivityIndicator, Linking, Text, View } from 'react-native';
import { openOutput } from './Outputs';
import { Block } from './render/Block';
import { CodeChip } from './render/CodeChip';
import { InlineThing, useWorktreeIds } from './render/Inline';
import { ViewCard } from './render/ViewCard';
import { TASK_LINK_SCHEME, codeWorktreeRefs, linkTaskKeys, readInline, splitInlineMath, tableView } from '../lib/render';
import { TaskChip, type TaskRef, useTaskIndex } from './render/TaskChip';
import { InlineMath, type MathMap } from './render/MathBlock';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { ago, useFile } from '../lib/hooks';
import type { ConvSummary, ProseView, SubAgentView, Topic } from '../lib/link/protocol';
import { color, tint, type } from '../lib/theme';
import { Card, IconBadge, Press, T, type Tone, toneInk } from './ui';

/** Pieces of a conversation: Claude's prose (code folded), the live step, sub-agents. */

/** A conversation's screen; `on`: one of your computers', opened over its own link (BLG-810). */
export const convHref = (topic: string, on?: string): string => `/conv/${encodeURIComponent(topic.replace(/^conv:/, ''))}${on ? `?on=${encodeURIComponent(on)}` : ''}`;
export const chatHref = (topic: string): string => `/chat/${encodeURIComponent(topic.replace(/^chat:/, ''))}`;

/** Base text style the inline pieces build on. */
type Base = { readonly fontSize: number; readonly color: string } & object;

/**
 * Words with their inline math (BLG-87): each `$…$` drawn as the Mac typeset it (or its TeX).
 * Prices ("$5 and $10") stay words (splitInlineMath).
 */
function withMath(s: string, base: Base, math: MathMap | undefined, key: () => number, bold = false): ReactNode[] {
  if (!s.includes('$')) return [s];
  return splitInlineMath(s).map((p) => ('tex' in p ? <InlineMath key={key()} tex={p.tex} {...(math ? { math } : {})} size={base.fontSize} ink={bold ? color.text : base.color} /> : p.text.replace(/\\\$/g, () => '$')));
}

/**
 * Inline: **bold**, `code` (an inline element when it reads as one: docs/views.md), [links](…),
 * and `$math$` in the words and bold around them (never inside code). `tasks`: the board's keys
 * (BLG-109); a bare "BLG-12" or "@BLG-12" it has is a task chip, as on the Mac (shared linkTaskKeys).
 */
function inline(s: string, base: Base, math?: MathMap, tasks?: ReadonlyMap<string, TaskRef>): ReactNode[] {
  const words = tasks?.size ? linkTaskKeys(s, (k) => tasks.has(k), { mentions: true }) : s;
  return pieces(words, base, math, tasks, false);
}

function pieces(s: string, base: Base, math: MathMap | undefined, tasks: ReadonlyMap<string, TaskRef> | undefined, bold: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  const re = bold ? /(`[^`]+`|!?\[[^\]\n]+\]\([^)\s]+\))/g : /(\*\*[^*]+\*\*|`[^`]+`|!?\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  const key = () => i++;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(...withMath(s.slice(last, m.index), base, math, key, bold));
    const tok = m[0];
    // Bold: its words, and what's inside it (a task chip, code, a link) drawn as anywhere else.
    if (tok.startsWith('**')) out.push(<Text key={i++} style={[base, { fontWeight: '700', color: color.text }]}>{pieces(tok.slice(2, -2), base, math, tasks, true)}</Text>);
    else if (tok.startsWith('[') || tok.startsWith('![')) {
      // A picture inside a sentence reads as its words, like a link (no stray "!").
      const lm = /^!?\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      const href = lm[2]!;
      // A task key (linkTaskKeys): its chip. A web link opens; anything else (a path on the Mac) reads as its words.
      if (href.startsWith(TASK_LINK_SCHEME)) {
        const k = href.slice(TASK_LINK_SCHEME.length);
        out.push(<TaskChip key={i++} k={k} task={tasks?.get(k)} />);
      } else
      out.push(
        /^https?:\/\//.test(href) ? (
          <Text key={i++} onPress={() => void Linking.openURL(href)} style={[base, { color: color.info, textDecorationLine: 'underline' }]}>
            {lm[1]}
          </Text>
        ) : (
          <Text key={i++} style={[base, { fontWeight: '600' }]}>
            {lm[1]}
          </Text>
        ),
      );
    } else {
      const el = readInline(tok.slice(1, -1));
      out.push(el ? <InlineThing key={i++} el={el} /> : <Text key={i++} style={[base, type.mono, { fontSize: 13.5, color: color.claude, backgroundColor: tint.claude }]}>{` ${tok.slice(1, -1)} `}</Text>);
    }
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(...withMath(s.slice(last), base, math, key, bold));
  return out;
}

export { CodeChip };

/** A Markdown table row's cells as written (`| a | b |`). */
const rowCells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
/** Its cells' words (no emphasis or code ticks): what a table view shows. */
const cells = (line: string): string[] => rowCells(line).map((c) => c.replace(/\*\*/g, '').replace(/`/g, ''));
const isRule = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/**
 * Claude's words: paragraphs, bullets, headings, Markdown tables (drawn as table views, as on the
 * Mac), pictures from the web, and what it drew (views, graphs, tasks: components/render), with
 * any other code folded into a chip. `at`: the conversation and turn, for a live view's rows.
 * `tasks`: a bare task key the board has ("BLG-98", "@BLG-98") is a live chip (BLG-109), and so is a
 * pasted "worktree:wt-…": your own words and your own Claude's only, as on the Mac (someone else's key
 * may be on their board).
 */
export function Prose({ prose, color: tone = color.text, size = 15.5, at, tasks: withTasks = false }: { readonly prose: ProseView; readonly color?: string; readonly size?: number; readonly at?: { topic: Topic; turn: string }; readonly tasks?: boolean }) {
  const base = { ...type.body, fontSize: size, lineHeight: size * 1.42, color: tone };
  const index = useTaskIndex(withTasks);
  const tasks = withTasks && index.size ? index : undefined;
  // A pasted "worktree:wt-…" of yours: its chip (BLG-878), on the same terms as the task keys.
  const worktrees = useWorktreeIds(withTasks);
  const text = useMemo(() => (worktrees.size ? codeWorktreeRefs(prose.text, (id) => worktrees.has(id)) : prose.text), [prose.text, worktrees]);
  type Block = { kind: 'p'; lines: string[] } | { kind: 'ul'; items: string[] } | { kind: 'h'; text: string } | { kind: 'code'; n: number } | { kind: 'table'; lines: string[] } | { kind: 'img'; alt: string; src: string };
  const blocks: Block[] = [];
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!.trimEnd();
    const last = blocks.at(-1);
    const marker = /^\s*\[\[code:(\d+)\]\]\s*$/.exec(line);
    const bullet = /^\s*(?:[-*]|\d+\.) (.*)/.exec(line);
    const heading = /^#{1,3} (.*)/.exec(line) ?? /^\*\*([^*]+)\*\*:?$/.exec(line);
    // A picture on a line of its own: from the web, a file on the Mac (its ref), or a Mac path an older Mac left as written.
    const img = /^\s*!\[([^\]]*)\]\((?:<([^>]+)>|([^)\s]+))\)\s*$/.exec(line);
    if (/^\s*\|.*\|\s*$/.test(line) && isRule(lines[li + 1] ?? '')) {
      // A table: its heading, the rule, and the rows after it.
      const t: string[] = [line];
      li += 1;
      while (li + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[li + 1]!)) t.push(lines[++li]!);
      blocks.push({ kind: 'table', lines: t });
    } else if (!line.trim()) blocks.push({ kind: 'p', lines: [] });
    else if (marker) blocks.push({ kind: 'code', n: Number(marker[1]) });
    else if (img) blocks.push({ kind: 'img', alt: img[1]!, src: (img[2] ?? img[3])! });
    else if (heading) blocks.push({ kind: 'h', text: heading[1]! });
    else if (bullet) {
      if (last?.kind === 'ul') last.items.push(bullet[1]!);
      else blocks.push({ kind: 'ul', items: [bullet[1]!] });
    } else if (last?.kind === 'p') last.lines.push(line);
    else blocks.push({ kind: 'p', lines: [line] });
  }
  const shown = blocks.filter((b) => b.kind !== 'p' || b.lines.length);
  return (
    <View style={{ gap: 9 }}>
      {shown.map((b, bi) => {
        if (b.kind === 'code') {
          const c = prose.code[b.n];
          if (c?.block) return <Block key={bi} entry={c} {...(at ? { at: { ...at, block: b.n } } : {})} {...(prose.math ? { math: prose.math } : {})} />;
          return <CodeChip key={bi} lang={c?.lang} lines={c?.lines ?? 0} />;
        }
        if (b.kind === 'table') {
          const [head, ...rows] = b.lines;
          const view = tableView({ columns: cells(head!), rows: rows.map(cells) });
          if (view) return <ViewCard key={bi} view={view} />;
          // One no view takes (too many columns): a line per row, its cells apart, never the pipes.
          return (
            <Text key={bi} style={base}>
              {b.lines.map((l, li) => (
                <Fragment key={li}>
                  {li > 0 ? '\n' : ''}
                  {inline(rowCells(l).filter(Boolean).join('  ·  '), base, prose.math, tasks)}
                </Fragment>
              ))}
            </Text>
          );
        }
        if (b.kind === 'img') return /^https?:\/\//.test(b.src) ? <WebImage key={bi} src={b.src} alt={b.alt} /> : b.src.startsWith('out:') ? <MacImage key={bi} refId={b.src} alt={b.alt} /> : <MacImage key={bi} alt={b.alt || b.src.split('/').pop() || 'Picture'} />;
        if (b.kind === 'h') {
          return (
            <Text key={bi} style={[base, { fontWeight: '700', marginTop: bi ? 4 : 0, marginBottom: -3 }]}>
              {inline(b.text, base, prose.math, tasks)}
            </Text>
          );
        }
        if (b.kind === 'ul') {
          return (
            <View key={bi} style={{ gap: 6 }}>
              {b.items.map((item, li) => (
                <View key={li} style={{ flexDirection: 'row', gap: 10, paddingRight: 6 }}>
                  <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: color.text3, marginTop: size * 0.6 }} />
                  <Text style={[base, { flex: 1 }]}>{inline(item, base, prose.math, tasks)}</Text>
                </View>
              ))}
            </View>
          );
        }
        return (
          <Text key={bi} style={base}>
            {b.lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 ? '\n' : ''}
                {inline(l.replace(/\[\[code:(\d+)\]\]/g, (_, n) => `‹code · ${prose.code[Number(n)]?.lines ?? 0} lines›`), base, prose.math, tasks)}
              </Fragment>
            ))}
          </Text>
        );
      })}
    </View>
  );
}

/** A picture from the web in Claude's words (a path on the Mac comes as an output instead). */
function WebImage({ src, alt }: { readonly src: string; readonly alt: string }) {
  return (
    <View style={{ borderRadius: 14, overflow: 'hidden', backgroundColor: color.sunken }}>
      <Image source={{ uri: src }} style={{ width: '100%', aspectRatio: 16 / 10 }} contentFit="cover" transition={200} accessibilityLabel={alt} />
      {alt ? <T v="caption" style={{ padding: 8 }}>{alt}</T> : null}
    </View>
  );
}


/**
 * A picture Claude showed from a file on the Mac (`![alt](out:…)`, views.ts withPictures): fetched
 * by ref like any output, thumb here, the full one in the viewer on a tap, at its own shape. No ref
 * (a Mac before this, or a path the phone may not see): a quiet tile with its name, never "!alt".
 */
function MacImage({ refId, alt }: { readonly refId?: string; readonly alt: string }) {
  const file = useFile(refId, 'thumb');
  const [aspect, setAspect] = useState(16 / 10);
  const open = () => refId && openOutput({ ref: refId, name: alt || 'Picture', kind: 'image' }, []);
  return (
    <Press haptics={false} disabled={!refId || !file?.uri} onPress={open} accessibilityLabel={alt} style={{ borderRadius: 14, overflow: 'hidden', backgroundColor: color.sunken }}>
      {file?.uri ? (
        <Image source={{ uri: file.uri }} style={{ width: '100%', aspectRatio: aspect }} contentFit="cover" transition={200} onLoad={(e) => e.source.width && e.source.height && setAspect(Math.max(0.5, Math.min(3, e.source.width / e.source.height)))} />
      ) : (
        <View style={{ width: '100%', aspectRatio: 16 / 10, alignItems: 'center', justifyContent: 'center' }}>
          {refId && file?.status !== 'error' ? <ActivityIndicator color={color.text3} /> : <ImageIcon color={color.text3} size={22} />}
        </View>
      )}
      {alt || !refId ? (
        <T v="caption" style={{ padding: 8 }}>
          {refId ? alt : `${alt} · on the Mac`}
        </T>
      ) : null}
    </Press>
  );
}

/** The live step: a calm dot and the step's words, changed in place (no rolling, nothing jumps). */
export function StepTicker({ step, tone = 'peach', size = 13.5 }: { readonly step?: string; readonly tone?: Tone; readonly size?: number }) {
  if (!step) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: size * 1.6, overflow: 'hidden' }}>
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: toneInk(tone) }} />
      <View style={{ flex: 1 }}>
        <T v="callout" c={toneInk(tone)} numberOfLines={1} style={{ fontSize: size, fontWeight: '600', fontVariant: ['tabular-nums'] }}>
          {step}
        </T>
      </View>
    </View>
  );
}

/** Sub-agents as small lavender dots: filled while running, hollow when done. */
export function AgentDots({ count, done = 0 }: { readonly count: number; readonly done?: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 3, alignItems: 'center' }}>
      {Array.from({ length: Math.min(count, 6) }, (_, i) => (
        <View key={i} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color.subagent }} />
      ))}
      {Array.from({ length: Math.min(done, 6) }, (_, i) => (
        <View key={`d${i}`} style={{ width: 6, height: 6, borderRadius: 3, borderWidth: 1.5, borderColor: color.subagent }} />
      ))}
    </View>
  );
}

const STATUS: Record<string, { Icon: typeof Bot; tone: Tone }> = {
  working: { Icon: Hourglass, tone: 'peach' },
  waiting: { Icon: CircleAlert, tone: 'butter' },
  failed: { Icon: CircleAlert, tone: 'rose' },
  idle: { Icon: MessageSquare, tone: 'plain' },
  done: { Icon: Check, tone: 'mint' },
};
export const statusIcon = (s: string) => STATUS[s] ?? STATUS.idle!;

/** A conversation in a list (Home's Running now). */
export function ConvCard({ c }: { readonly c: ConvSummary }) {
  const st = statusIcon(c.needsYou ? 'waiting' : c.status);
  const working = c.status === 'working';
  return (
    <Press scaleTo={0.985} onPress={() => router.push(convHref(c.topic))} style={{ marginHorizontal: 16 }}>
      <Card style={{ padding: 14, gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          {c.project && c.projectId ? (
            <View>
              <ProjectMark name={c.project} icon={c.icon} size={36} />
              {/* What it's doing, as a small badge on the project's mark. */}
              <View style={{ position: 'absolute', right: -4, bottom: -4, borderRadius: 10, borderWidth: 2, borderColor: color.card }}>
                <IconBadge Icon={st.Icon} tone={st.tone} size={18} />
              </View>
            </View>
          ) : (
            <IconBadge Icon={st.Icon} tone={st.tone} size={36} />
          )}
          <View style={{ flex: 1 }}>
            <T v="heading" numberOfLines={1}>
              {c.title}
            </T>
            <T v="caption" numberOfLines={1}>
              {[c.project, c.needsYou ? 'needs you' : undefined, ago(c.lastAt)].filter(Boolean).join(' · ')}
            </T>
          </View>
          {c.fresh ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, height: 24, paddingHorizontal: 8, borderRadius: 12, backgroundColor: tint.sky }}>
              <Images color={color.info} size={12} />
              <T v="caption" c={color.info} style={{ fontWeight: '700' }}>
                {c.fresh}
              </T>
            </View>
          ) : null}
          {/* Commits in its worktree its open PR doesn't have yet (BLG-840): merging now would leave them out. */}
          {c.notOnPr ? <NotOnPrChip gap={c.notOnPr} /> : null}
          {c.agents ? <AgentDots count={c.agents} /> : null}
          <ChevronRight color={color.text3} size={18} />
        </View>
        {working && c.last ? <StepTicker step={c.last} /> : null}
      </Card>
    </Press>
  );
}

/** "↑3": commits in a worktree its open PR doesn't have (BLG-840), the Mac row's chip; its label says it in words. */
export function NotOnPrChip({ gap }: { readonly gap: NonNullable<ConvSummary['notOnPr']> }) {
  return (
    <View accessibilityLabel={notOnPrWords(gap)} style={{ flexDirection: 'row', alignItems: 'center', gap: 2, height: 24, paddingHorizontal: 8, borderRadius: 12, backgroundColor: tint.sky }}>
      <ArrowUp color={color.info} size={12} strokeWidth={2.2} />
      <T v="caption" c={color.info} style={{ fontWeight: '700' }}>
        {gap.count}
      </T>
    </View>
  );
}

/** "3 commits not on PR #398". */
export const notOnPrWords = (gap: NonNullable<ConvSummary['notOnPr']>): string => `${gap.count} commit${gap.count === 1 ? '' : 's'} not on PR #${gap.pr}`;

/** A row of sub-agent chips under a turn. */
export function AgentChips({ agents, onOpen }: { readonly agents: readonly SubAgentView[]; readonly onOpen: (a: SubAgentView) => void }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {agents.map((a) => {
        const t: Tone = a.status === 'running' ? 'lavender' : a.status === 'failed' ? 'rose' : 'mint';
        const Icon = a.status === 'done' ? Check : a.status === 'failed' ? CircleAlert : Bot;
        return (
          <Press key={a.id} onPress={() => onOpen(a)} style={{ flexDirection: 'row', alignItems: 'center', gap: 7, height: 34, paddingHorizontal: 12, borderRadius: 17, backgroundColor: tint[t] }}>
            <Icon color={toneInk(t)} size={15} strokeWidth={1.9} />
            <T v="caption" c={toneInk(t)} numberOfLines={1} style={{ fontWeight: '600', maxWidth: 200 }}>
              {a.title}
            </T>
            {a.outputs.length ? (
              <T v="caption" c={toneInk(t)} style={{ opacity: 0.7, fontWeight: '700' }}>
                {a.outputs.length}
              </T>
            ) : null}
          </Press>
        );
      })}
    </View>
  );
}
