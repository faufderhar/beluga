import type { GraphStep } from '@beluga/shared/graph-spec.js';
import { IconButton } from '../ui.js';
import g from './graph.module.css';

/** The walkthrough's caption: which step, what it shows, and Back / Next (← →, Esc to leave). */
export function Walkthrough({ steps, index, onGo }: { steps: readonly GraphStep[]; index: number; onGo: (i: number) => void }) {
  const step = steps[index];
  if (!step) return null;
  const last = index === steps.length - 1;
  return (
    <div className={g.walk} role="region" aria-label="Walkthrough" aria-live="polite">
      <div className={g.walkDots} aria-hidden="true">
        {steps.map((s, i) => (
          <button key={`${i}:${s.title}`} type="button" tabIndex={-1} className={g.walkDot} data-on={i === index ? 'true' : i < index ? 'past' : 'false'} onClick={() => onGo(i)} />
        ))}
      </div>
      <div className={g.walkMain}>
        <div className={g.walkText}>
          <span className={g.walkCount}>
            Step {index + 1} of {steps.length}
          </span>
          <span className={g.walkTitle}>{step.title}</span>
          {step.text ? <span className={g.walkBody}>{step.text}</span> : null}
        </div>
        <div className={g.walkNav}>
          <IconButton size="small" icon="back" label="Previous Step" keys="←" disabled={index === 0} onClick={() => onGo(index - 1)} />
          {last ? (
            <button type="button" className={g.walkDone} onClick={() => onGo(-1)}>
              Done
            </button>
          ) : (
            <button type="button" className={g.walkNext} onClick={() => onGo(index + 1)}>
              Next
            </button>
          )}
          <IconButton size="small" icon="x" label="Leave the Walkthrough" keys="esc" onClick={() => onGo(-1)} />
        </div>
      </div>
    </div>
  );
}
