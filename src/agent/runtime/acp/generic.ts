import type { AcpExtension } from './extension.js';

/** Claude's aliases and a local model's `[…]` value mean nothing to another agent: those run on its own choice. */
const CLAUDE_ALIASES = /^(default|opus|sonnet|haiku|best|opusplan)(\[1m\])?$/i;

/**
 * What the core needs for an ACP agent it has no extension of its own for (a built-in one, one from
 * the ACP Registry, a command of yours): Beluga's instructions ahead of a new conversation's first
 * message, the generic tool dialect, Beluga's tools over HTTP when it takes them so (else stdio), a
 * model list that starts with Default, and its model ids as it names them (`provider/model` too).
 */
export function genericExtension(): AcpExtension {
  return {
    defaultModel: true,
    model: (model) => (!model || CLAUDE_ALIASES.test(model.trim()) || model.startsWith('[') ? undefined : model.trim()),
  };
}
