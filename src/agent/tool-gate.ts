import { type PolicyContext, SECRET_DECLINED, decideTool, denyReason } from './policy.js';
import type { AgentRunInput } from './types.js';

export const OWNER_DECLINED = 'The machine owner declined this action.';

/**
 * Whether one tool call may run, the way every runtime asks it: the run's vetTool first (a
 * friend's limits), then Beluga's policy, then you (canUseSecret for a .env file, canUseTool for
 * the rest). Undefined: allowed; a string: denied, and why. Claude's canUseTool asks this, and so
 * does the stdio tool server (agent/tool-host.ts), so a call denied one way is denied the other.
 */
export async function gateTool(toolName: string, toolInput: Record<string, unknown>, input: Pick<AgentRunInput, 'vetTool' | 'canUseTool' | 'canUseSecret' | 'asksFirst'>, policy: PolicyContext): Promise<string | undefined> {
  const veto = input.vetTool?.(toolName, toolInput);
  if (veto) return veto;
  const decision = decideTool(toolName, toolInput, policy);
  if (decision === 'deny') return denyReason(toolName, toolInput, policy);
  if (decision === 'secret') return (await input.canUseSecret?.(toolName, toolInput)) ? undefined : SECRET_DECLINED;
  if ((decision === 'allow' && !input.asksFirst?.(toolName)) || (await input.canUseTool(toolName, toolInput))) return undefined;
  return OWNER_DECLINED;
}
