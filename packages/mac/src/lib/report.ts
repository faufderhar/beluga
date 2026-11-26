import { fileManager } from './os-words.js';

/** What a problem report says about itself (core/blackbox/report.ts `ReportSummary`). */
export interface ReportSummaryLike {
  readonly version: string;
  readonly os: string;
  readonly problems: number;
  readonly lastProblem?: string;
}

/** A new issue on `repo` (lib/support.ts GITHUB_URL) with the report's summary filled in, asking for the file to be attached (BLG-673). */
export function problemIssueUrl(repo: string, summary: ReportSummaryLike, file: string): string {
  const body = [
    '**What happened?**',
    '',
    '',
    '**What did you expect?**',
    '',
    '',
    '---',
    `Beluga ${summary.version} on ${summary.os}`,
    `Problems Beluga noticed: ${summary.problems}${summary.lastProblem ? ` (the latest: ${summary.lastProblem})` : ''}`,
    '',
    `Drag the report here to attach it: \`${file}\` (Beluga just showed it in ${fileManager()}). It has no secrets, but have a look first if you like.`,
  ].join('\n');
  const title = summary.lastProblem ? `Problem: ${summary.lastProblem}` : 'Problem: ';
  return `${repo}/issues/new?${new URLSearchParams({ title: title.slice(0, 120), body }).toString()}`;
}
