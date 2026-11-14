import { useRef, useState } from 'react';
import type { PendingQuestion } from '@beluga/core/collab-store.js';
import { isDecisionQid } from '@beluga/core/plans/decisions.js';
import { answerTyped, currentQuestion } from '@beluga/ui/collab-actions.js';
import { Markdown } from '../chat/Markdown.js';
import { MentionHighlighter } from '../chat/MentionHighlighter.js';
import { useAttachments } from '../chat/use-attachments.js';
import { Icon } from '../components/Icon.js';
import { Button, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { toast, useApi, useBeluga } from '../lib/beluga.js';
import { chosenOf } from './plan-ask-model.js';
import a from '../chat/attention.module.css';
import c from '../chat/composer.module.css';
import s from './plan-ask.module.css';

/**
 * In the plan's conversation, above its box: what's asked of you here, answered right here. A
 * task of yours in the plan (a decision: no worktree for it) or the plan's Claude asking: the
 * question, its options (pick one, or several and Done), and your own words instead, with
 * images pasted or dropped in as in any message box.
 */
export function PlanAsk({ q }: { q: PendingQuestion }) {
  const actions = useActions();
  const { client } = useBeluga();
  const api = useApi();
  const [own, setOwnState] = useState('');
  const words = useRef('');
  const box = useRef<HTMLTextAreaElement>(null);
  const setOwn = (next: string): void => {
    words.current = next;
    setOwnState(next);
  };
  const att = useAttachments({
    channel: `ask:${q.qid}`,
    box,
    text: () => words.current,
    setText: (next, cursor) => {
      setOwn(next);
      requestAnimationFrame(() => box.current?.setSelectionRange(cursor, cursor));
    },
    finderDrops: false,
  });
  const current = currentQuestion(q);
  if (!current) return null;
  const decision = isDecisionQid(q.qid);
  const chosen = chosenOf(q, current.question);
  const total = q.question.kind === 'question' ? q.question.questions.length : 1;
  const index = q.question.kind === 'question' ? q.question.questions.indexOf(current) : 0;
  const write = (): void => {
    const { text, images, shown, putBack } = att.take(own.trim());
    if (!text) return;
    setOwn('');
    if (!images.length) return answerTyped(client, q, text);
    // An image still being saved is waited for (it showed in the box at once), as the composer does.
    att
      .saved(images)
      .then((real) => api.attachments.expand(text, q.channel, [...real], [...shown]))
      .then(
        (expanded) => answerTyped(client, q, expanded),
        (err: unknown) => {
          setOwn(own);
          putBack();
          toast(client, `Couldn't send the images: ${err instanceof Error ? err.message : String(err)}`, 'error');
        },
      );
  };
  const writing = Boolean(own.trim()) || att.images.length > 0;
  return (
    <div className={cx(a.card, s.card)} role="group" aria-label={decision ? 'Your call' : 'Your agent asks'} data-testid="plan-ask">
      <div className={a.head}>
        <Icon name={decision ? 'hand' : 'claude'} size={13} className={a.claude} />
        <span className={a.title}>{current.header || (decision ? 'Your call' : 'Your agent asks')}</span>
        {total > 1 ? (
          <span className={a.more}>
            {index + 1} of {total}
          </span>
        ) : null}
        {/* A decision of yours waits until you answer it; Claude's question can be skipped. */}
        {decision ? null : (
          <Button size="small" variant="quiet" onClick={() => actions.run({ type: 'answer', qid: q.qid, pick: 'skip' })}>
            Skip
          </Button>
        )}
      </div>
      <div className={cx(a.question, s.question, 'selectable')}>
        <Markdown text={current.question} />
      </div>
      {current.options.length ? (
        <div className={a.options} role={current.multiSelect ? 'group' : 'radiogroup'} aria-label={current.multiSelect ? 'Pick any' : 'Pick one'}>
          {current.options.map((o, i) => {
            const on = chosen.has(o.label);
            return (
              <button
                key={o.label}
                type="button"
                role={current.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={on}
                className={cx(a.option, on && a.optionOn)}
                onClick={() => actions.run({ type: 'answer', qid: q.qid, pick: 'option', label: o.label, question: current.question })}
              >
                <span className={a.optionKey}>{current.multiSelect ? <Icon name={on ? 'check' : 'plus'} size={10} /> : i + 1}</span>
                <span className={a.optionText}>
                  <span className={a.optionLabel}>{o.label}</span>
                  {o.description ? <span className={a.optionDesc}>{o.description}</span> : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      {att.waiting}
      <form
        className={s.own}
        {...att.dropProps}
        onSubmit={(e) => {
          e.preventDefault();
          write();
        }}
      >
        {/* An image's "[1  name]" is drawn as its chip, as in the plan's own box. */}
        <div className={cx(c.inputWrap, s.ownWrap)}>
          <MentionHighlighter text={own} input={box} className={s.ownInput ?? ''} />
          <textarea
            ref={box}
            rows={1}
            className={cx(s.ownInput, c.overHighlight, 'selectable')}
            value={own}
            placeholder={current.options.length ? 'Or write your own…' : 'Your answer…'}
            aria-label="Write your own answer"
            onChange={(e) => setOwn(e.target.value)}
            onPaste={att.onPaste}
            onKeyDown={(e) => {
              if (att.onRefKey(e)) return;
              if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              write();
            }}
          />
        </div>
        {writing ? (
          <Button size="small" variant="primary" type="submit">
            Answer
          </Button>
        ) : current.multiSelect ? (
          <Button size="small" variant="primary" disabled={!chosen.size} onClick={() => actions.run({ type: 'answer', qid: q.qid, pick: 'done', question: current.question })}>
            Done{chosen.size ? ` (${chosen.size})` : ''}
          </Button>
        ) : null}
      </form>
      {decision ? <div className={a.hint}>Your answer goes on the task, and the plan carries on with what waited on it.</div> : null}
    </div>
  );
}
