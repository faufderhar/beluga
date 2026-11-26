/** What new worktrees' branches start with (`beluga/fix-login`); empty: just the name. */
export const BRANCH_PREFIX_DEFAULT = 'beluga/';
/** A prefix git accepts in front of a slug: letters, digits, `. _ - /`, no `..`, `//`, or part starting with `.` `-` `/`. */
export const BRANCH_PREFIX_RE = /^(?![./-])(?!.*\.\.)(?!.*\/\/)(?!.*\/[.-])[\w./-]{0,40}$/;
