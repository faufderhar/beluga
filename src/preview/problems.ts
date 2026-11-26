import { type PreviewProblem, problem } from '../shared/preview/opened.js';

/**
 * A build that failed, worded for people (preview/bundle.ts). The headline and the line under it
 * never quote the bundler; what it said goes, whole, to Claude when you ask it to fix the preview.
 */

/** What esbuild says went wrong (the part of its Message we read). */
export interface BuildMessage {
  readonly text: string;
  readonly location?: { readonly file: string; readonly line: number; readonly column: number; readonly lineText?: string } | null;
}

const REACT = /^(react|react-dom)(\/|$)/;

/** What the build's fence (bundle.ts fencePlugin) says about a file outside the worktree. */
export const OUTSIDE = 'Previews read only files in this worktree and installed packages';

/** A package's name from what was imported ("@radix-ui/react-dialog/dist" → "@radix-ui/react-dialog"). */
export function packageOf(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

const isRelative = (spec: string): boolean => /^(\.{1,2}\/|\/|[@~#]\/|\$lib(\/|$))/.test(spec);

/** How the bundler's messages read in the details Claude gets. */
export function detailsOf(messages: readonly BuildMessage[]): string {
  return messages
    .slice(0, 8)
    .map((m) => (m.location ? `${m.location.file}:${m.location.line}:${m.location.column}: ${m.text}${m.location.lineText ? `\n    ${m.location.lineText.trim()}` : ''}` : m.text))
    .join('\n');
}

/**
 * `file`: the component's path in the worktree (for "around line 12 of PriceCard.tsx").
 * `installed`: the worktree has its packages (node_modules) at all.
 */
export function buildProblem(messages: readonly BuildMessage[], file: string, installed: boolean): PreviewProblem {
  const details = detailsOf(messages);
  const name = file.split('/').pop() ?? file;
  const outside = messages.find((m) => m.text.startsWith(OUTSIDE));
  if (outside) return problem('build', `${name} reads a file from outside this worktree`, 'Previews only read the worktree’s own files and its packages.', `The preview of ${file} imports a file outside the worktree, or one that may hold secrets, which previews never read.\n${details}`);
  const unresolved = messages.map((m) => /Could not resolve "([^"]+)"/.exec(m.text)?.[1]).filter((s): s is string => Boolean(s));
  const missing = unresolved.find((s) => !isRelative(s));
  if (missing && (!installed || REACT.test(missing))) {
    return problem('not-installed', 'This project’s packages aren’t installed here yet', 'Once they are, the preview draws itself. Your agent can set that up.', `The preview of ${file} couldn't be built because packages aren't installed in this worktree (npm install or the project's setup has not run).\n${details}`);
  }
  if (missing) return problem('missing-package', `${name} uses ${packageOf(missing)}, which isn’t installed`, 'Add it to the project, and the preview draws itself.', `The preview of ${file} needs the package ${packageOf(missing)}, which isn't installed.\n${details}`);
  const local = unresolved[0];
  if (local) return problem('missing-import', `${name} imports a file that isn’t there`, 'The preview draws itself again once it can find it.', `The preview of ${file} couldn't find ${local}.\n${details}`);
  const where = messages.find((m) => m.location)?.location;
  if (where) {
    const at = where.file.split('/').pop() ?? where.file;
    return problem('syntax', `${at} doesn’t read right around line ${where.line}`, 'It may be halfway through a change. The preview catches up when the file is saved again.', `The preview of ${file} failed to build.\n${details}`);
  }
  return problem('build', `${name} couldn’t be put together for a preview`, 'Your agent can look at why.', `The preview of ${file} failed to build.\n${details}`);
}
