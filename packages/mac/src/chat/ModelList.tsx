import { type KeyboardEvent, type Ref, useEffect, useMemo, useRef, useState } from 'react';
import type { PickerGroup, PickerModel } from '@beluga/shared/agent-picker.js';
import { MODEL_PAGE, SEARCH_MODELS_OVER, modelSections, providerName, providerOf, searchModels, shownCount } from '@beluga/shared/model-search.js';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { useApi } from '../lib/beluga.js';
import { foreignMark, modelFlavor } from './model-words.js';
import s from './picker.module.css';

interface ModelListProps {
  readonly group: PickerGroup;
  readonly onPick: (value: string) => void;
  /** The search field, for the popover to focus when it opens on a long list. */
  readonly searchRef?: Ref<HTMLInputElement>;
}

/**
 * What a row says of its provider: nothing under the provider's own heading ("deepseek · 128K
 * context": 128K context); else its name as people say it ("Moonshot AI (Kimi) · 262K context").
 */
function describe(desc: string, provider: string, under: string): string {
  if (!provider || (desc !== provider && !desc.startsWith(`${provider} · `))) return desc;
  const rest = desc.slice(provider.length + 3);
  return under ? rest : [providerName(provider), rest].filter(Boolean).join(' · ');
}

/**
 * One agent's models in the picker (BLG-945, GitHub #504). A long list (OpenCode with every
 * provider you've set up) gets a search field on top and each provider's models under its name,
 * and draws a page at a time, more as you scroll near the end (the picked one always drawn, and
 * scrolled to). Typing searches every model, the best matches first; Enter picks the first.
 * OpenCode's list ends with a way to add a provider (DeepSeek, Kimi…): OpenCode's own sign-in.
 */
export function ModelList({ group, onPick, searchRef }: ModelListProps) {
  const [query, setQuery] = useState('');
  const [wanted, setWanted] = useState(MODEL_PAGE);
  const scroller = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const searchable = group.models.length > SEARCH_MODELS_OVER;
  const searching = searchable && query.trim() !== '';
  // Searching: one list, best first. Else each provider's under its name (one untitled section when there's one).
  const sections = useMemo(() => (searching ? [{ provider: '', label: '', models: searchModels(group.models, query, group.runtime) }] : modelSections(group.models, group.runtime)), [group.models, group.runtime, query, searching]);
  const ordered = useMemo(() => sections.flatMap((x) => x.models), [sections]);
  const count = shownCount(ordered.length, wanted, searching ? -1 : ordered.findIndex((m) => m.on));

  // Another agent, or another search: from the top again, a page at first.
  useEffect(() => {
    setWanted(MODEL_PAGE);
    scroller.current?.scrollTo({ top: 0 });
  }, [group.runtime, query]);
  // Near the end of what's drawn: the next page.
  useEffect(() => {
    const root = scroller.current;
    const last = end.current;
    if (!root || !last || count >= ordered.length) return undefined;
    const seen = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setWanted(count + MODEL_PAGE), { root, rootMargin: '0px 0px 160px 0px' });
    seen.observe(last);
    return () => seen.disconnect();
  }, [count, ordered.length]);
  // Opened on a long list: the picked model in view.
  useEffect(() => {
    if (searchable) scroller.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [group.runtime, searchable]);

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && ordered[0] && !ordered[0].why) {
      e.preventDefault();
      onPick(ordered[0].value);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      scroller.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    } else if (e.key === 'Escape' && query) {
      // The first Escape clears the search; the next closes the picker.
      e.preventDefault();
      e.stopPropagation();
      setQuery('');
    }
  };

  let left = count;
  return (
    <>
      {searchable ? (
        <label className={s.searchRow}>
          <Icon name="search" size={12} />
          <input ref={searchRef} className={s.search} type="search" value={query} placeholder={`Search ${group.models.length} models`} aria-label={`Search ${group.label} models`} spellCheck={false} autoComplete="off" onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey} />
        </label>
      ) : null}
      <div ref={scroller} className={cx(s.scroll, searchable && s.scrollTall)}>
        <div className={s.models} role="radiogroup" aria-label={`${group.label} models`}>
          {sections.map((section) => {
            const rows = section.models.slice(0, Math.max(0, left));
            left -= rows.length;
            if (!rows.length) return null;
            return (
              <div key={section.provider || 'all'} className={s.section} role="group" aria-label={section.label || undefined}>
                {section.label ? <div className={s.sectionHead}>{section.label}</div> : null}
                {rows.map((m) => (
                  <ModelRow key={m.value || 'default'} model={m} runtime={group.runtime} agent={group.label} under={section.provider} onPick={onPick} />
                ))}
              </div>
            );
          })}
          {count < ordered.length ? <div ref={end} className={s.more}>{`${ordered.length - count} more…`}</div> : null}
          {searching && !ordered.length ? <div className={s.why}>{`No ${group.label} model matches “${query.trim()}”.`}</div> : null}
        </div>
      </div>
      {group.runtime === 'opencode' ? <AddProvider /> : null}
    </>
  );
}

function ModelRow({ model: m, runtime, agent, under, onPick }: { model: PickerModel; runtime: string; agent: string; under: string; onPick: (value: string) => void }) {
  const maker = foreignMark(m.value, runtime);
  // Under a provider's heading the provider isn't said again; searching (no heading), it is: the same model may come from two.
  const desc = m.why ?? (describe(m.description, providerOf(m.value, runtime), under) || modelFlavor(m.value, m.label, agent));
  return (
    <button type="button" role="radio" aria-checked={m.on} disabled={Boolean(m.why) && !m.on} title={[m.label, m.value, desc].filter(Boolean).join(' · ')} className={cx(s.model, m.on && s.modelOn, m.why && s.modelOff)} onClick={() => onPick(m.value)}>
      <span className={s.radio}>{m.on ? <Icon name="check" size={9} /> : null}</span>
      {maker ? <Icon name={maker} size={12} className={s.maker} /> : null}
      <span className={s.modelName}>{m.label}</span>
      {desc ? <span className={s.modelDesc}>{desc}</span> : null}
    </button>
  );
}

/**
 * OpenCode's models are its providers': another one (DeepSeek, Kimi, OpenRouter…) is added with
 * OpenCode's own sign-in, in Terminal. Then Look Again lists its models here.
 */
function AddProvider() {
  const api = useApi();
  const [asked, setAsked] = useState(false);
  const [looking, setLooking] = useState(false);
  const lookAgain = (): void => {
    setLooking(true);
    void api.workbench
      .checkAgents()
      .catch(() => undefined)
      .finally(() => {
        setLooking(false);
        setAsked(false);
      });
  };
  return (
    <div className={s.addProvider}>
      {asked ? (
        <button type="button" className={s.addLink} disabled={looking} onClick={lookAgain}>
          <Icon name="refresh" size={11} />
          {looking ? 'Looking…' : 'Done in Terminal? Look again'}
        </button>
      ) : (
        <button type="button" className={s.addLink} title="Runs opencode auth login in Terminal: pick DeepSeek, Moonshot AI (Kimi), OpenRouter or any other provider" onClick={() => void api.workbench.agentSignIn('opencode').then((opened) => opened && setAsked(true))}>
          <Icon name="plus" size={11} />
          Add a provider: DeepSeek, Kimi…
        </button>
      )}
    </div>
  );
}
