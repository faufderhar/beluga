import { type ReactNode, useState } from 'react';
import { BRANCH_PREFIX_RE } from '@beluga/shared/branch-prefix.js';
import { type NamingSource, PR_TITLE_RULE_MAX, namingFor } from '@beluga/shared/naming.js';
import type { ResolvedScripts } from '@beluga/workspaces/scripts.js';
import { Field, SourceTag, TextInput } from '../../components/FormSheet.js';
import { useApi, useApp } from '../../lib/beluga.js';

type Key = 'branchPrefix' | 'prTitle';

const SOURCE: Record<NamingSource, { label: string; tone: 'team' | 'mine' | 'guess'; detail: string }> = {
  yours: { label: 'Your settings', tone: 'mine', detail: 'Only you have it, for this project' },
  team: { label: 'beluga.json', tone: 'team', detail: 'Shared with everyone on the project' },
  settings: { label: 'From Settings', tone: 'guess', detail: 'Your rule for every project (Settings › Workspaces)' },
  default: { label: 'Built-in', tone: 'guess', detail: 'Beluga’s own' },
};

export interface NamingFields {
  readonly fields: ReactNode;
  readonly changed: boolean;
  readonly valid: boolean;
  /** Save what changed (team: into beluga.json, with whatever rules this project has). */
  readonly save: (team: boolean) => void;
}

/**
 * A project's naming rules in Project Settings › General (BLG-1033): its branch prefix and how its
 * pull requests are titled. Empty: the next rule counts (beluga.json, then Settings), shown greyed in the field.
 */
export function useNamingFields(project: { readonly id: string; readonly name: string; readonly scripts?: ResolvedScripts } | undefined, team: boolean): NamingFields {
  const api = useApi();
  const prefs = useApp((st) => st.prefs);
  const yours = project ? prefs.projectNaming?.[project.name] : undefined;
  const teamRules = project?.scripts?.naming;
  // What this project's own rule is now (yours, else beluga.json): the field shows it; empty is "none of its own".
  const own = (key: Key): string => yours?.[key] ?? teamRules?.[key] ?? '';
  const [values, setValues] = useState<Record<Key, string>>({ branchPrefix: own('branchPrefix'), prTitle: own('prTitle') });
  const edited = (key: Key): boolean => values[key].trim() !== own(key);
  // Without this project's rules: what it would follow (Settings', else Beluga's).
  const fallback = namingFor({ ...prefs, projectNaming: {} });
  const now = namingFor(prefs, project);
  const prefixOk = BRANCH_PREFIX_RE.test(values.branchPrefix.trim());
  const hasOwn = Boolean(yours || teamRules);

  const tag = (key: Key): ReactNode => {
    if (edited(key)) return <SourceTag tone={team ? 'team' : 'mine'}>{team ? 'Will go in beluga.json' : 'Will be yours'}</SourceTag>;
    const source = key === 'branchPrefix' ? now.branchPrefix.source : now.prTitle?.source;
    if (!source) return <SourceTag tone="guess">None</SourceTag>;
    return (
      <span title={SOURCE[source].detail}>
        <SourceTag tone={SOURCE[source].tone}>{SOURCE[source].label}</SourceTag>
      </span>
    );
  };
  const set = (key: Key) => (v: string) => setValues({ ...values, [key]: key === 'branchPrefix' ? v.trim() : v });

  const fields = (
    <>
      <Field
        label="Branch prefix"
        htmlFor="naming-branch"
        error={prefixOk ? undefined : 'Use letters, digits and . _ - / only.'}
        hint={`New worktrees get branches like ${values.branchPrefix.trim() || fallback.branchPrefix.value}fix-login. Empty: ${fallback.branchPrefix.value ? `Settings’ (${fallback.branchPrefix.value})` : 'Settings’ (no prefix)'}.`}
        aside={tag('branchPrefix')}
      >
        <TextInput id="naming-branch" value={values.branchPrefix} onChange={set('branchPrefix')} mono invalid={!prefixOk} placeholder={fallback.branchPrefix.value || 'none'} maxLength={40} />
      </Field>
      <Field label="PR titles" htmlFor="naming-pr" hint={`Your agent follows it when it titles a pull request. Empty: ${fallback.prTitle ? 'Settings’ rule' : 'no rule'}.`} aside={tag('prTitle')}>
        <TextInput id="naming-pr" value={values.prTitle} onChange={set('prTitle')} placeholder={fallback.prTitle?.value ?? 'feat(scope): summary, under 70 characters'} maxLength={PR_TITLE_RULE_MAX} />
      </Field>
    </>
  );

  const changed = edited('branchPrefix') || edited('prTitle');
  const save = (toTeam: boolean): void => {
    if (!project || (!changed && !(toTeam && hasOwn))) return;
    // Yours: only what you changed, so a rule from beluga.json isn't copied into yours. The team's: all of them.
    const patch = Object.fromEntries((['branchPrefix', 'prTitle'] as const).filter((key) => toTeam || edited(key)).map((key) => [key, values[key].trim() || null]));
    void api.projects.setNaming(project.id, patch, toTeam);
  };
  return { fields, changed, valid: prefixOk, save };
}
