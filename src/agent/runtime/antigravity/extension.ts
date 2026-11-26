import path from 'node:path';
import type { AcpExtension } from '../acp/extension.js';
import { dropAgyLog, findAgy } from './connection.js';
import { AGY_ASK_TOOL, agyAnswerPrompt, agyQuestion } from './questions.js';
import { readAgyQuota } from './quota.js';
import { agyRulesFreeDir, rulesFreeArgs } from './rules-free.js';
import { agyFailure, agyModel, agyThought, systemMeta } from './run-parts.js';
import { agyBrainDir, agyDataDir, dropAgySession, tidyAgyData } from './sessions.js';
import { agyDialect, belugaToolOf } from './tools.js';

export interface AgyExtensionOptions {
  /** Where Antigravity keeps its conversations (its own notes are written there). */
  readonly dataDir?: string;
  /** The Antigravity CLI's executable; unset: findAgy(). */
  readonly bin?: string;
}

/**
 * What Antigravity does past ACP, for the core: its instructions in its system prompt (`_meta`), its
 * thinking levels, its tools' names, its own notes, its ask_question, /compact, its failures in its
 * own words, its quota (from its own language server), and what its looks leave behind.
 */
export function antigravityExtension(opts: AgyExtensionOptions = {}): AcpExtension {
  const data = opts.dataDir ?? agyDataDir();
  return {
    instructions: systemMeta,
    // Over HTTP, as before the core: agy takes MCP servers over HTTP without saying so in its initialize.
    mount: 'http',
    tools: { dialect: agyDialect, belugaToolOf },
    model: agyModel,
    effort: (effort) => {
      const value = agyThought(effort);
      return value ? { id: 'thought_level', value } : undefined;
    },
    // Its notes folder, by either path: agy may name it through Beluga's Gemini folder (rules-free.ts), a link to the same one.
    ownNote: (sessionId, file) =>
      [data, ...(opts.dataDir ? [] : [path.join(agyRulesFreeDir(), 'antigravity-cli')])].some((dir) => {
        const rel = path.relative(agyBrainDir(sessionId, dir), file);
        return !rel.startsWith('..') && !path.isAbsolute(rel);
      }),
    questions: { tool: AGY_ASK_TOOL, detect: agyQuestion, answer: agyAnswerPrompt },
    compact: true,
    failure: agyFailure,
    quota: () => {
      const bin = opts.bin ?? findAgy();
      return bin ? readAgyQuota({ bin }) : Promise.resolve(undefined);
    },
    tidy: () => tidyAgyData(data),
    dropSession: (sessionId) => dropAgySession(sessionId),
    afterLook: (pid) => dropAgyLog(pid),
    // Your project's rules, not Antigravity's global ones.
    launch: () => rulesFreeArgs(),
  };
}
