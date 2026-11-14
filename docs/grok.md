# Grok Build

Beluga can run [Grok Build](https://x.ai/cli), xAI's coding agent, beside Claude, Codex, OpenCode and local models. It runs the Grok Build you have installed, signed in with your own account.

## Set it up

1. Install Grok Build: `curl -fsSL https://x.ai/cli/install.sh | bash`.
2. Sign in once: `grok login`, or **Sign In** beside it in **Settings › Agent**.
3. Open **Settings › Agent** (or the "Your agents" step when you first open Beluga). Grok Build shows **Ready** once Beluga finds it, and **Check Again** looks again.

Make it yours with the radio button, or pick it for one conversation in the agent picker above the message box. Its models are listed under Grok Build, each with the efforts it takes. `BELUGA_GROK_PATH` points Beluga at a particular `grok`.

## What works

- Worktrees and chats, with steps on the card as they happen: reads, edits, commands, searches and Beluga's own tools.
- Approvals: every step Grok takes comes to Beluga first, reads included, and Beluga asks you when Claude would. `.env` files and keys are turned down unless you say yes. When a step is turned down, Grok is told why and carries on.
- **Plan** first, then approve: a read-only turn answers with the plan, and nothing changes until you approve it.
- **Stop**, and **Steer Now**, which stops the turn and answers your message next. Grok takes one message at a time, so a message you send while it works waits for its turn.
- **Compact**, **Fork**, picking up a conversation later, and handing a conversation to another agent.
- **/btw** side questions, answered from what the conversation already knows.
- Pictures in a message.
- Your skills: Grok Build loads your Claude Code skills itself. Claude Code's custom commands (`~/.claude/commands`) are expanded for it, and its own commands work as typed.
- Sub-agents: each one its `spawn_subagent` tool starts is a row on the card.
- Usage: tokens and cost for each turn (fresh input, output, cache reads and cache writes, each once), the context meter for Grok's own window (it updates while a turn is still running, including the cache hit rate), and the current billing period. On the daemon route `grok usage` prints it. On the shell route, where that command can't, Beluga asks Grok for `_x.ai/billing` (the period `/usage` shows, including the subscription name). When neither can be read, Usage shows those four counts from conversations on this Mac and says the period isn't available from here.

## What's different

- **No Terminal view.** Grok Build conversations stay in the chat, and the Chat ⇄ Terminal switch isn't offered there.
- **Friends' tasks go to Claude or Codex, and guests can't prompt it.** Beluga can only ask about every step through a Grok hook, and a company's Grok policy can switch such hooks off, with no sandbox to fall back on.
- **Editing a sent message** puts the files back, but the conversation starts afresh from your edited message.
- **Questions mid-run**: Grok Build asks in its answer, and you reply in the box.
- **Its web search runs on xAI's side**, so Beluga sees it as a step but isn't asked first.
- **Your MCP servers**: the ones in your Grok config run in its conversations, as they do in Grok. Settings › MCP lists Claude Code's and Codex's.
- **Deleting a worktree** deletes its conversation's Grok session, but not other sessions you ran in that folder yourself.

## How it runs

Each run is one `grok agent --no-leader stdio` process speaking the [Agent Client Protocol](https://agentclientprotocol.com) (`src/agent/runtime/grok/`), with one session per conversation.

- **Every step asks.** Left alone, Grok runs what it thinks is read-only without asking. Beluga starts it with a plugin for that one process (`--plugin-dir`) holding a `PreToolUse` hook that answers `ask`, which sends every call to `session/request_permission`, read-only ones and saved "always allow" grants too. Your Grok config isn't touched.
- **A step turned down ends Grok's turn** (`stopReason: cancelled`), unlike other agents. Beluga sends it back to work with the reason, up to eight times per message.
- **Its own `exit_plan_mode`** is turned down: allowed, it asks the screen for an approval over `_x.ai/exit_plan_mode`, and ends the turn when that goes unanswered. Grok is told to answer with the plan, and Beluga shows its own approval card.
- **Beluga's instructions** go in `_meta.rules` when a session is made. Grok ignores them when a session is resumed, so a resumed conversation gets them in its first message.
- **Forks** use Grok's own `_x.ai/session/fork`, which standard ACP doesn't have.
- Shapes were recorded from Grok Build 1.0.77. `npx tsx scripts/live-grok.ts` checks the real thing, on your account, with a cheap model.
