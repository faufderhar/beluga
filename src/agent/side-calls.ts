import { answerChat } from './chat-answer.js';
import { nameTask, titleChat, titlePlan } from './namer.js';
import { reviewPr } from './pr-reviewer.js';
import { describeProject } from './project-describer.js';
import type { Complete } from './runtime/types.js';
import { fixRun, fixSetup, workOutScripts } from './setup-fixer.js';
import { draftTask } from './task-drafter.js';
import { standIn } from './stand-in.js';
import type { AgentBackend } from './types.js';

type SideCalls = Required<Pick<AgentBackend, 'nameTask' | 'titlePlan' | 'titleChat' | 'answerChat' | 'fixSetup' | 'fixRun' | 'workOutScripts' | 'draftTask' | 'describeProject' | 'reviewPr' | 'standIn'>>;

/**
 * The one-shot calls a backend makes besides runs (BLG-441): naming worktrees and plans, drafting
 * tasks, answering a friends' chat, fixing a setup, describing a project, reviewing a pull request,
 * answering for you on Full Autopilot (stand-in.ts).
 * Each goes through a runtime's `complete`, so any default agent does them, not only Claude.
 * `cwd`: the room's folder; `model`: the backend's default (only a chat answer follows it).
 */
export function sideCalls(complete: Complete, cwd: string, model?: string): SideCalls {
  return {
    nameTask: (prompt) => nameTask(prompt, { cwd, complete }),
    titlePlan: (goal) => titlePlan(goal, { cwd, complete }),
    titleChat: (content) => titleChat(content, { cwd, complete }),
    answerChat: (req) => answerChat(req, { cwd, complete, ...(model ? { model } : {}) }),
    fixSetup: (dir, failed, output) => fixSetup(dir, failed, output, { complete }),
    fixRun: (dir, failed, output) => fixRun(dir, failed, output, { complete }),
    workOutScripts: (dir, want) => workOutScripts(dir, want, { complete }),
    draftTask: (text, ctx) => draftTask(text, ctx, { cwd, complete }),
    describeProject: (dir, project) => describeProject(dir, project, { complete }),
    reviewPr: (input) => reviewPr(input, { complete }),
    standIn: (req) => standIn(req, { cwd, complete, ...(model ? { model } : {}) }),
  };
}
