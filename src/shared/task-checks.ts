/**
 * A task held for its checks, in the words both screens show (the Mac's task page, the phone's):
 * how many criteria are neither ticked nor explained, and what that keeps it out of. `merged`: its
 * work already merged (BLG-952), so it's kept out of Done rather than out of review.
 */
export function checksWords(open: number, merged: boolean): string {
  const what = open === 1 ? 'A criterion is' : `${open} criteria are`;
  return merged
    ? `Its work merged, but ${what.toLowerCase()} neither ticked nor explained, so it stays out of Done: tick each one, add “— deferred: why” after it, or mark it Done.`
    : `${what} neither ticked nor explained, so it stays out of review: tick each one, or add “— deferred: why” after it.`;
}
