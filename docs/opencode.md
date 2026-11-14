# OpenCode

Beluga can run [OpenCode](https://opencode.ai) as your agent, beside Claude, Codex and local models. It runs the OpenCode you have installed, with the models you've set up in it (its free ones too).

## Set it up

1. Install OpenCode: `brew install sst/tap/opencode`, or `npm i -g opencode-ai`.
2. Open **Settings › Agent** (or the "Your agents" step when you first open Beluga). OpenCode shows **Ready** once Beluga finds it, and **Check Again** looks again.
3. To use your own provider's models (Anthropic, OpenAI, OpenRouter…), run `opencode auth login` in Terminal once. If OpenCode has no model it can use, **Sign In** beside it does that for you.

Make it yours with the radio button, or pick it for one conversation in the agent picker above the message box. Its models are listed under OpenCode, each with the efforts it takes.

## Many providers, and finding a model

OpenCode lists every model of every provider you've set up, so the list can get long (OpenRouter alone brings hundreds). In the agent picker:

- Each provider's models sit under its name: OpenCode Zen, Anthropic, DeepSeek, Moonshot AI (Kimi), OpenRouter…
- **Search** sits on top of a long list, and has the cursor when the picker opens on it. Type any part of a model's name or its provider ("kimi", "deepseek free", "openrouter qwen"): the best matches come first, and **Enter** picks the first. The first **Esc** clears the search.
- The list draws a page of models at a time, and more as you scroll, with the model you picked always shown.
- **Choose the Model…** (in the command palette) has the same search. On the phone, the picker has a search field too. It shows the first 30 models, always with the one you picked, and says how many more are on your Mac.

## DeepSeek and Kimi

OpenCode runs DeepSeek's and Moonshot AI's Kimi models with your own API key, or through OpenRouter.

1. Press **Add a provider** at the foot of OpenCode's models in the agent picker. It runs `opencode auth login` in Terminal.
2. Pick **DeepSeek** or **Moonshot AI** (or **Moonshot AI (China)**, or **OpenRouter**), and paste your key.
3. Back in Beluga, press **Look again** in the picker. The new models show under their provider, each with its own mark.

## What works

- Worktrees and chats, with steps on the card as they happen: reads, edits, commands, searches and Beluga's own tools.
- Approvals: OpenCode asks Beluga before every step, and Beluga asks you when Claude would. `.env` files and keys are turned down unless you say yes.
- **Plan** first, then approve: OpenCode's own plan agent looks around and changes nothing until you approve.
- **Stop**, and **Steer Now**, which stops the turn and answers your message next. OpenCode takes one message at a time, so a message you send while it works waits for its turn.
- **Compact**, **Fork**, picking up a conversation later, and handing a conversation to another agent.
- **/btw** side questions, answered from what the conversation already knows.
- Pictures in a message, when the model takes them.
- Your skills: OpenCode loads your Claude Code skills itself. Claude Code's custom commands (`~/.claude/commands`) are expanded for it, and OpenCode's own commands (`/init`, `/review`) work as typed.
- Sub-agents: each one its task tool starts is a row on the card.
- Usage: tokens and cost for each turn, and the context meter.

## What's different

- **No Terminal view.** OpenCode conversations stay in the chat, and the Chat ⇄ Terminal switch isn't offered there.
- **Friends' tasks go to Claude or Codex.** Your OpenCode plugins can let a step through before Beluga is asked, so a task a friend sends you runs on Claude (or Codex) when one is set up here, and their card says so.
- **No guests.** A guest you invite into a project can't prompt OpenCode: switch that conversation to Claude for them.
- **Editing a sent message** puts the files back, but the conversation starts afresh from your edited message.
- **Questions mid-run**: OpenCode asks in its answer, and you reply in the box.
- **Your MCP servers**: the ones in your OpenCode config run in its conversations, as they do in OpenCode. Settings › MCP lists Claude Code's and Codex's.
