# GitHub Copilot

Beluga can run [GitHub Copilot](https://github.com/features/copilot/cli) as your agent, beside Claude, Codex, OpenCode and local models. It runs the Copilot CLI you have installed, signed in with your own GitHub account. Copilot Free is enough.

## Set it up

1. Install Copilot CLI: `brew install --cask copilot-cli`, or `npm i -g @github/copilot`.
2. Sign in once in Terminal: `copilot login`. Your GitHub account needs Copilot turned on: Copilot Free is enough, at [github.com/settings/copilot](https://github.com/settings/copilot).
3. Open **Settings › Agent** (or the "Your agents" step when you first open Beluga). Copilot shows **Ready** once Beluga finds it signed in. **Sign In** beside it runs `copilot login` for you, and **Check Again** looks again.

Make it yours with the radio button, or pick it for one conversation in the agent picker above the message box.

## Models

Copilot is listed with **Auto** first: Copilot picks the model for each message. On Copilot Free, Auto is the only choice. On a paid plan, the models Copilot offers you are listed under it too. If you set a model in Copilot itself (`/model`, or `COPILOT_MODEL`), Beluga uses it until you pick one here.

If your plan doesn't include a model you picked, the card says so and tells you to pick Auto.

## What works

- Worktrees and chats, with steps on the card as they happen: reads, edits, commands, searches, and Beluga's own tools.
- Approvals: when Copilot asks before a step (an edit, a command that changes something, a file outside the folder, an MCP tool), Beluga asks you when Claude would.
- **Plan** first, then approve: Copilot's own Plan mode looks around and changes nothing until you approve.
- **Stop**, and **Steer Now**, which stops the turn and answers your message next. Copilot takes one message at a time, so a message you send while it works waits for its turn.
- **Compact**, picking up a conversation later, and handing a conversation to another agent.
- Pictures in a message.
- Your skills: Copilot loads your Claude Code skills and commands itself, and its own commands (`/review`, `/init`) work as typed.
- Usage: tokens for each turn, and the context meter.

## What's different

- **Reads without asking.** Copilot reads files in the folder and runs commands that only look (`ls`, `git status`) without asking first. Beluga turns its reads of `.env` files, keys and credential folders down outright, so those stay out.
- **Friends' tasks go to Claude or Codex.** Because Copilot doesn't ask before every step, a task a friend sends you runs on Claude (or Codex) when one is set up here, and their card says so.
- **No guests.** A guest you invite into a project can't prompt Copilot: switch that conversation to Claude for them.
- **No Fork, no /btw.** Copilot can't branch a conversation, so a fork starts a fresh Copilot conversation (the files come along), and editing a sent message starts afresh from your edited message.
- **No Terminal view.** Copilot conversations stay in the chat.
- **Questions mid-run**: Copilot asks in its answer, and you reply in the box.
- **Your plan's requests.** Every message you send uses one of your Copilot requests, and so do Beluga's small asks when Copilot is your agent (naming a worktree, drafting a task). Copilot doesn't tell Beluga how many you have left: check [github.com/settings/copilot](https://github.com/settings/copilot).
- **Your MCP servers**: the ones in your Copilot config (and its GitHub server) run in its conversations, as they do in Copilot. Settings › MCP lists Claude Code's and Codex's.
