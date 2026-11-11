# Local and bring-your-own models

Beluga can run your agent on your own models instead of Anthropic's: Ollama on this Mac first, or
any Anthropic-compatible address (LiteLLM, a company proxy). It's still Claude Code doing the work,
with the same tools, room features, approvals and safety rules; only the model behind it changes.
How good the answers are depends on that model, and the picker says so.

## Ollama (the first route)

1. Install Ollama (ollama.com, or `brew install ollama`) and start it with room for Claude Code's
   instructions: `OLLAMA_CONTEXT_LENGTH=32768 ollama serve`. With Ollama's default (a few thousand
   tokens) those get cut off, and the model ignores the task and its tools.
2. Pull a model that is good with tools, for example `ollama pull qwen3-coder`.
3. In Beluga, open the agent box you type in, then pick **Local model** on its left. Ollama on this
   Mac shows up by itself, with the models it has. Pick one.

That worktree now runs on that model. Nothing is sent to Anthropic for its runs.

Small models answer, read files and use Beluga's tools, but slowly and less reliably than Claude:
on a busy M-series Mac, `qwen3:4b` took a few minutes for a read-a-file-and-post-to-chat task.
A larger coding model (`qwen3-coder`, `gpt-oss:20b`) is the better pick if your Mac has the memory.

## Any Anthropic-compatible address

**Settings › Claude › Local models › Add Endpoint**: a name, its address, a key if it needs one,
and its models (leave empty to use the ones it lists). Ollama on another machine
(`http://box:11434`), LiteLLM (`http://localhost:4000`) and company proxies work the same way.

The address and key are kept on this Mac in `~/.beluga/env.json` with your other environment
variables (readable only by you). The key is never shown again, only whether one is saved; neither
goes into chat, reports or anything the room sees. The picker shows only an endpoint's name and models.

An endpoint that doesn't answer stays in the picker, greyed, saying so. Beluga looks again every
30 seconds, and at once with **Check Again**.

## How it works

An endpoint is config, not a new agent (`src/agent/runtime/local.ts`): a run on one is the Claude
runtime with `ANTHROPIC_BASE_URL` pointed at the endpoint, every model alias (Opus, Sonnet, Haiku,
sub-agents, the small fast model) set to the endpoint's model, the endpoint's key (or a placeholder)
as `ANTHROPIC_AUTH_TOKEN` so your Claude sign-in never goes to someone else's server, and Claude
Code's own traffic (telemetry, error reports, updates) switched off. The picker's value is
`<endpoint>/<model>`, kept as the worktree's model. Side calls (naming a worktree, drafting a task)
stay with your default agent.
