import type { Step } from './onboarding-model.js';
import { thisComputer } from '../lib/os-words.js';

/**
 * The tour's words, one idea a step (BLG-989). The scene does the explaining, so the words stay
 * short: a title that names what you can do, one sentence on how, and, where the scene can be
 * played with, a hint saying what to click. No label chips over the title, no checklists, no
 * slogans, no "not X, but Y".
 */
export interface TourCopy {
  readonly title: string;
  readonly body: string;
  /** What to try in the scene, when there's something to click. */
  readonly hint?: string;
}

export const TOUR_COPY: Readonly<Partial<Record<Step, TourCopy>>> = {
  parallel: {
    title: 'Run several tasks at the same time.',
    body: 'Each task gets its own folder, branch and agent, so they never get in each other’s way.',
  },
  scratch: {
    title: 'Watch screenshots and logs arrive as your agent works.',
    body: 'Your agent saves what it makes to a Scratch folder as it goes. Open any of it right away, without waiting for the run to end.',
    hint: 'Pick a request, then click a file to open it.',
  },
  tables: {
    title: 'Ask about your data and get a table back.',
    body: 'Your agent finds the database, runs the query and answers with a table you can sort, search and chart.',
    hint: 'Click a heading to sort by it.',
  },
  machines: {
    title: 'Run tasks on your other computers.',
    body: `Start a task on a Mac mini, a Linux box or a server and follow it from ${thisComputer()} or your phone. An Always On computer keeps working while this one sleeps.`,
  },
  friends: {
    title: 'Your agent can ask a friend’s agent.',
    body: 'When it needs a file, a login or a screenshot that only a friend’s computer has, it asks their agent. They click Allow and the result comes back.',
    hint: 'Pick an errand, then click Allow as Ada.',
  },
  together: {
    title: 'Invite a friend into your session.',
    body: 'They watch your agent work as it happens. Let them follow along, or let them talk to your agent too.',
    hint: 'Click Share, choose what Ada can do, then Invite.',
  },
  sentinel: {
    title: 'Start work every morning, or when tests fail.',
    body: 'Describe it in one sentence. When the moment comes, your agent does the work and leaves you a report.',
    hint: 'Pick one to watch it run.',
  },
  earnings: {
    title: 'See what each project earns.',
    body: 'Connect Stripe or RevenueCat and each project shows its revenue next to its work.',
  },
  archive: {
    title: 'Clear out finished worktrees.',
    body: 'Archiving deletes the folder to free up disk space. The branch and the conversation stay.',
  },
};
