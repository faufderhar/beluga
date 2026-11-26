import { type CSSProperties, memo, useMemo, useState } from 'react';
import { type Span, TERMINAL_FOLD, readTerminal } from '@beluga/shared/render/terminal.js';
import { ActionsContext, type ActionItem } from '../SpecMenu.js';
import { Icon } from '../Icon.js';
import { cx } from '../ui.js';
import { copyText } from '../../lib/copy.js';
import { toast, useBeluga } from '../../lib/beluga.js';
import { useCopied } from '../markdown/CodeBlock.js';
import { runnableCommand } from '@beluga/shared/render/run-command.js';
import b from './blocks.module.css';

/**
 * A terminal session Claude showed (a command and what it printed, a log, ANSI colors): drawn as
 * a soft, slightly sunken terminal. Prompts are quiet and commands stand out; ANSI colors come
 * from a soft palette (light and dark); errors and warnings get a faint tint; long output shows
 * its last lines first. Copy on hover; right-click for the commands, wrapping and quoting.
 */

/** Fences that just say "a shell": no need to name them. */
const GENERIC = /^(|console|terminal|term|shell|sh|bash|zsh|shell-session|sh-session|shellsession|bash-session|zsh-session|text|txt|plain|plaintext|output|stdout|ansi)$/;

const color = (c: Span['fg']): string | undefined => (c ? (c.startsWith('#') ? c : `var(--ansi-${c})`) : undefined);

function styleOf(s: Span): CSSProperties | undefined {
  if (!s.fg && !s.bg && !s.bold && !s.dim && !s.italic && !s.underline) return undefined;
  return {
    ...(s.fg ? { color: color(s.fg) } : {}),
    ...(s.bg ? { background: color(s.bg), borderRadius: 2 } : {}),
    ...(s.bold ? { fontWeight: 600 } : {}),
    ...(s.dim ? { opacity: 0.62 } : {}),
    ...(s.italic ? { fontStyle: 'italic' } : {}),
    ...(s.underline ? { textDecoration: 'underline' } : {}),
  };
}

function Spans({ spans }: { spans: readonly Span[] }) {
  return (
    <>
      {spans.map((s, i) => {
        const style = styleOf(s);
        return style ? (
          <span key={i} style={style}>
            {s.text}
          </span>
        ) : (
          s.text
        );
      })}
    </>
  );
}

/** `onRun`: Run types the session's commands into the terminal here (your own and your own Claude's only). */
export const Terminal = memo(function Terminal({ code, lang, onQuote, onRun }: { code: string; lang?: string | undefined; onQuote?: ((fence: string) => void) | undefined; onRun?: ((command: string) => void) | undefined }) {
  const { client } = useBeluga();
  const term = useMemo(() => readTerminal(code), [code]);
  const [wrap, setWrap] = useState(false);
  const [all, setAll] = useState(false);
  const [copied, copyNow] = useCopied();
  const copy = (text: string, what: string): void => void copyText(text).then(() => toast(client, `Copied ${what}`, 'success'));
  const hidden = all ? 0 : Math.max(0, term.lines.length - TERMINAL_FOLD);
  const shown = hidden ? term.lines.slice(hidden) : term.lines;
  const name = (lang ?? '').toLowerCase();
  const command = useMemo(() => (onRun ? runnableCommand(lang, code) : undefined), [onRun, lang, code]);
  const run = command && onRun ? () => onRun(command) : undefined;
  const items: ActionItem[] = [
    ...(run ? [{ label: term.commands.length > 1 ? 'Run the Commands in Terminal' : 'Run in Terminal', icon: 'play' as const, onSelect: run }] : []),
    { label: 'Copy Output', icon: 'copy', separate: Boolean(run), onSelect: () => copy(term.copy, 'the output') },
    ...(term.commands.length ? [{ label: term.commands.length === 1 ? 'Copy Command' : 'Copy Commands', icon: 'terminal' as const, onSelect: () => copy(term.commands.join('\n'), term.commands.length === 1 ? 'the command' : 'the commands') }] : []),
    { label: 'Wrap Long Lines', icon: 'wrap', separate: true, checked: wrap, onSelect: () => setWrap(!wrap) },
    ...(hidden ? [{ label: `Show All ${term.lines.length} Lines`, onSelect: () => setAll(true) }] : []),
    ...(onQuote ? [{ label: 'Quote in Reply', icon: 'chat' as const, separate: true, onSelect: () => onQuote(`\`\`\`${lang ?? 'console'}\n${term.plain}\n\`\`\``) }] : []),
  ];
  return (
    <ActionsContext items={items}>
      <div className={cx(b.block, b.term, wrap && b.wrap)} data-block="terminal">
        <div className={b.termHead}>
          <span className={b.termChip}>
            <Icon name="terminal" size={12} />
            {GENERIC.test(name) ? 'Terminal' : name}
          </span>
          {term.commands.length > 1 ? <span>{term.commands.length} commands</span> : null}
        </div>
        <div className={b.tools}>
          {run ? (
            <button type="button" className={b.tool} aria-label="Run in the terminal" title={command} onClick={run}>
              <Icon name="play" size={12} />
              Run
            </button>
          ) : null}
          <button type="button" className={b.tool} aria-label="Copy the output" onClick={() => copyNow(term.copy)}>
            <Icon name={copied ? 'check' : 'copy'} size={12} />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        {hidden ? (
          <button type="button" className={cx(b.moreRow, b.termMore)} onClick={() => setAll(true)}>
            <Icon name="chevronUp" size={11} />
            Show {hidden} earlier {hidden === 1 ? 'line' : 'lines'}
          </button>
        ) : null}
        <pre className={b.termBody}>
          <code>
            {shown.map((line, i) => (
              <span key={hidden + i} className={b.termLine} data-kind={line.kind}>
                {line.kind === 'prompt' ? (
                  <>
                    <span className={b.prompt}>{line.prompt}</span>
                    <span className={b.command}>
                      <Spans spans={line.spans} />
                    </span>
                  </>
                ) : (
                  <Spans spans={line.spans} />
                )}
              </span>
            ))}
          </code>
        </pre>
      </div>
    </ActionsContext>
  );
});
