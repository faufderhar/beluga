import { Icon } from '../components/Icon.js';
import { type DiffComment, commentWhere, removeComment } from '../views/diff-comments.js';
import { useWaitingComments } from '../views/DiffComment.js';
import s from './composer.module.css';

/** The first changed line a comment is on (else its first line), sign and all, for its card; blank lines skipped. */
function firstLine(c: DiffComment): string {
  const said = c.code.filter((l) => l.slice(1).trim());
  return said.find((l) => l[0] === '+' || l[0] === '-') ?? said[0] ?? '';
}

/**
 * Comments on the changes (views/DiffComment.tsx) waiting above the message box: each a card with
 * where it is, the line it's on and what you said. They go after your words when you send.
 */
export function CommentCards({ box }: { box: string }) {
  const comments = useWaitingComments(box);
  if (!comments.length) return null;
  return (
    <div className={s.commentCards} role="list" aria-label="Comments on the changes">
      {comments.map((c) => {
        const where = commentWhere(c);
        const line = firstLine(c);
        return (
          <div key={c.id} role="listitem" className={s.commentCard} aria-label={`Comment on ${where}`}>
            <div className={s.commentHead}>
              <Icon name="chat" size={11} />
              <span className={s.commentWhere} title={where} translate="no">
                {where}
              </span>
              <button type="button" aria-label={`Remove the comment on ${where}`} onClick={() => removeComment(box, c.id)}>
                <Icon name="x" size={9} />
              </button>
            </div>
            {line ? (
              <div className={s.commentCode} data-sign={line[0]} translate="no">
                {line.slice(1).trim()}
              </div>
            ) : null}
            <div className={s.commentSaid} translate="no">{c.text}</div>
          </div>
        );
      })}
    </div>
  );
}
