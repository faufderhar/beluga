# Usage statistics

Beluga is free and open source. We can't see how it's used, so people who choose to share usage statistics are how we learn what to fix and build next. This page says exactly what is sent at each level. The code that does it is in `src/telemetry/`. Who receives it, why, for how long and your rights are in the [privacy notice](privacy.md).

To send your agents' traces to your own tools (Ratel Cloud, Langfuse, Datadog and others), see [Your own traces](traces.md). That's separate from this page, and nothing here changes it.

## Who can send

Only Beluga's own releases can send. When a release is built, `scripts/build-sidecar.mjs` writes `telemetry-release.json` beside the daemon, using `BELUGA_TELEMETRY_URL`, `BELUGA_TELEMETRY_KEY` and `BELUGA_TELEMETRY_PRODUCT_KEY`:

- **On the maintainer's Mac,** `scripts/release-mac.mjs` reads them from the environment or from `~/.tauri/beluga-telemetry.json`. It refuses to release without them unless you pass `--no-telemetry`.
- **In CI,** the release workflow reads them from its secrets, and only for a release.

Statistics go to two [Ratel](https://ratel.sh) projects, each with its own **ingest-only** key. A key can add data to one project, and it can't read anything back. That's why it's safe inside an app.

- **The Beluga project** (`BELUGA_TELEMETRY_PRODUCT_KEY`, `productKey` in the file): Beluga's own data. Which features are used, calls to Beluga's own tools, app moments, this computer's kind. Sent at Essential and On.
- **The agents project** (`BELUGA_TELEMETRY_KEY`, `key`): your agents' sessions. Their turns, tokens and cost, every tool they call with what it was given and what came back (masked), Claude Code's own telemetry, and the masked text. Sent at On only.

Without a product key, both go to the one project.

A build from source has no such file. It never asks, never shows the setting, and never sends anything. A few more cases:

- If you want your own build to send to your own Ratel projects, set `BELUGA_TELEMETRY_URL`, `BELUGA_TELEMETRY_KEY` and, for a second project, `BELUGA_TELEMETRY_PRODUCT_KEY` in the daemon's environment.
- `BELUGA_TELEMETRY=0` turns it all off, whatever else says.
- The demo never sends.

## The levels

| Level | What's sent |
| --- | --- |
| **Off** | Nothing. |
| **Essential** | How Beluga's own features are used, to the Beluga project. No agent sessions, no text. See the next section. |
| **On** | Essential, plus your agents' sessions to the agents project: their turns, their tool calls with arguments and results, Claude Code's own telemetry, and the text of your own conversations. Text, arguments and results are masked first. |

Nothing is sent before a level is chosen.

- **New installs** choose on the last step of the onboarding. No level is picked for you: only a click on Essential or On shares. Skip, or Continue and Finish with nothing picked, is Off.
- **Installs that updated** get one ask, at a calm moment, never while one of your agents is running. No level is picked for you there either:
  - **Share** shares at the level you picked. It waits until you pick one.
  - **Keep It Off** (Off picked) is the same as No thanks.
  - **Later**, or closing it, sends nothing and asks again in 3 days or after 5 merged pull requests, whichever comes first.
  - **No thanks** turns it off and never asks again.

You can change the level any time in **Settings › General › Usage statistics**, or in the phone's **Settings**. Turning it off clears anything not sent yet.

**Leaving a project out.** In a project's **Settings** (General), uncheck **Send usage statistics from this project**:

- **Nothing from its runs is sent:** no turns, no tool calls, no text. Its main folder and all its worktrees count.
- **Calls to Beluga's tools** from those runs aren't sent either.
- **Claude Code's own telemetry** isn't turned on for those runs.
- **The level in Settings › General** still applies to every other project, and changing it keeps your exclusions.
- **Feature counts and this computer's kind** aren't tied to a project, so they're still sent at Essential and On.

## What Essential sends

All of it goes to the Beluga project.

- **Calls to Beluga's own tools,** for every runtime (Claude, Codex, OpenCode, Copilot, Antigravity, local models). These are the tools named `mcp__beluga…`, such as `mcp__beluga_board__task_update` or `mcp__beluga_sentinel__sentinel_create`. For each turn that used one:
  - which agent ran it and where (a worktree, a project, a plan, a sentinel's own run, a friend's task), and how the turn ended: finished, stopped (by you, a steer or a timeout: never counted as a failure) or failed. A failed turn has a kind (your usage limit, signed out, a crash, the network, the provider's API, or another error) and the first line of what it said, stripped (below);
  - each Beluga tool call by name, how long it took and whether it failed. A failure has a kind (a timeout, a refusal, a stop, a failed command, a rejected input, or another error) and the first line of what Beluga's tool said, stripped (below). A call that you declined, or didn't answer, isn't a failure: it says so instead. A call that waited for you (an approval, a question) says how long you took and how you answered; one that waited behind the calls before it says how long it waited. A tool's input and output are never sent.

  **What a failure says, stripped:** only its first line, at most 160 characters, with anything quoted taken out (titles, names, what was typed), and paths, links, emails, task keys, ids, long numbers and keys by their shapes replaced. What stays is the sentence Beluga or the runtime wrote, such as "There's no milestone … in the approved plan" or "Invalid arguments for tool plan_gate: … at verdict". Another tool's failure (a command, a file) sends only its kind.

  No model, tokens, cost, other tools or text. A turn that used none of Beluga's tools sends nothing. It's sent as OpenTelemetry spans: an `invoke_agent` span with `execute_tool` spans under it.
- **Features used:** the name of each action a screen takes, i.e. an API method such as `session.submit`, with how often, how many failed and how long they took, summed per minute. Never what was in it.
- **App moments:** the onboarding's steps, the ask being shown, and the level you chose. Names only.
- **This computer's kind,** once a day: the operating system and its version, the chip, the number of cores, memory rounded to a gigabyte, the language, the Beluga and Node versions, and which agents are installed. No name, no address, no time zone, no screen size.

Each install has a random id, made once and kept in `~/.beluga/telemetry.json`. It counts installs and isn't linked to anything else. Settings › General › Usage statistics shows it once a level is chosen, Off too (you need it for a request after you withdraw), with **Copy** and **Reset ID**: a new id from then on, what was waiting and the feature counts not yet sent are dropped, and what was sent stays under the old one. Conversations are identified by a hash of that id and the agent's session id, never the session id itself.

## What On adds to the agents project

- **Each turn of an agent,** for every runtime:
  - the runtime and model, the effort. The model goes as its full id (`claude-opus-5-5`); a name you picked (`opus`) goes apart, and when a turn never said the id, the one an earlier turn said that name stood for;
  - tokens and cache tokens, cost, how long it took, how it ended;
  - the kind of error and its first line, stripped (as above); a stop is never an error;
  - every tool call by name, how long it took, whether it failed and the kind of failure (as above). That covers Beluga's own tools and other MCP servers' tools, e.g. `mcp__github__search`;
  - what kind of call it was, worked out on your computer:
    - **a command** (`Bash`): the program it ran, as the tool's name (`Bash:git`), its subcommand for a few known tools (`commit`, `pr create`, `run build`), the names of every program in the line, how many parts the line had, and the exit code. Only program names and subcommands, never their arguments;
    - **an MCP tool:** its server and its own name, apart (`beluga_board`, `task_update`);
    - **a skill:** its name, where it lives (your settings, the project's, a plugin), and whether the model called it or you typed it as a slash command;
    - **Codex:** Codex's own name for the tool beside the one Beluga shows (`commandExecution` for `Bash`);
  - **what each tool was given and what came back,** on runs of yours only, masked and cut. See the next section;
  - **sub-agents:** each one as its own `invoke_agent` span, named by its type (`Explore`), with its model requests and its tool calls under it;
  - **thinking:** how long it took and how many tokens, never what was thought;
  - how many sub-agents and compactions;
  - the length of the prompt and the answer;
  - where it ran: the kind of place, and by name the project (as the repo), the branch, the worktree, the board task (`BLG-42`) and the pull request's number. Names are sent as they are, not hashed;
  - **the agent's own program:** its version, how it asks before acting (its permission mode), and the effort;
  - **waits for a person:** each time the run waited for you (an approval, a `.env` file, a question, a plan to approve), how long, and how it ended (approved, declined, answered, skipped, or no answer in time). A step that failed only because you said no, or didn't answer, is sent as a wait, not as a failed tool. What a question asked is sent on runs of yours only, masked. Your answer, a plan's text and the command you approved are never part of it;
  - **permission decisions:** for each tool call, whether it was let run and what decided (you, a rule, a hook);
  - **compactions:** when, what started each one (you or the agent), and the context's size before and after. Never the summary;
  - **hooks:** each time Claude Code ran hooks, which event (`PreToolUse`), the hook's name, where it's set, how long it took and how it ended. Never what a hook printed;
  - **the context's size** at each model request, and the window's size;
  - **the tools the model was given,** by name, and the names of its MCP servers. Never their descriptions or schemas;
  - **what a call changed:** for a file edit, the file's extension and how many lines went in and out (never its path); for a command, whether it made a commit, opened a pull request or ran tests, worked out from program names and subcommands only.

  It's sent as OpenTelemetry spans in the `gen_ai` shape Ratel reads: an `invoke_agent` span, a `chat` span for each model request, and each `execute_tool` span under the request that asked for it. Waits, permission decisions, compactions and hooks are events on those spans. A cost the runtime doesn't report (Codex) isn't sent as zero: it's left out.
- **Claude Code's own telemetry,** caught on your computer and filtered before it's queued. Beluga only turns it on at On:
  - each model request's model, tokens, cost and duration;
  - tool results and permission decisions;
  - compactions, MCP connections, lines changed, commits and pull requests.

  Claude Code adds your email, organization and account ids, and those are always dropped. So are prompts, answers, commands, file paths and error messages. Its ids for a request and for a sub-agent are used on your computer to put each tool call under the request that asked for it, and are never sent. Only events and counters named `claude_code.*` are kept. Beluga never turns on Claude Code's prompt or tool-detail logging. If you already send Claude Code's telemetry somewhere yourself, in your environment, your Beluga variables or Claude Code's `settings.json`, Beluga leaves that alone.
- **The text of your conversations, and your tools' arguments and results,** below.

## The text On adds, and how it's masked

The words you typed and your agent's answers, on turns you asked for yourself on this computer. Only what you typed is sent, never what Beluga adds to the prompt: worktree paths, task text, a conversation carried over to another agent, sent-file notes. These never send text:

- turns a friend, a friend's agent or an external agent asked for;
- compactions;
- room chat, friends' messages, and anything else from other people, even when it's part of the conversation.

**What each tool was given and what came back** (a command's text, a file's path and the lines read or written, an MCP tool's arguments and its answer) is sent the same way, on runs that are yours: the ones you typed, and the ones Beluga started for you (a task's agent, a sentinel). A run a friend, a friend's agent or a guest asked for sends neither, only what kind of call it was. Each is masked like the text, then cut to about 4,000 characters. A tool's output is already cut to its start and end when it's long, before any of this.

If you change the level, it's checked again when a turn is queued and when it's sent. Turns, text and tool calls already waiting don't go once you leave On.

Text, arguments and results are masked on your computer before a span is built from them:

1. **Exact values:** your saved variables, every project's `.env` and `.env.local` values, and your endpoints' keys. Values shorter than 6 characters, and plain words like `production`, aren't treated as secrets.
2. **Keys by their shape:** Anthropic, OpenAI, GitHub, GitLab, Slack, Stripe, AWS, Google, npm, Hugging Face, Ratel and Sentry keys, JWTs, Bearer tokens, and private key blocks.
3. **`name = value` secrets**, such as `API_KEY=…` or `"password": "…"`, and passwords inside URLs.
4. **Emails,** and anyone's home folder (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`, replaced by `~`).

Text longer than 32,000 characters is cut first. Masking runs a turn at a time between other work, so it never holds a run up.

Never sent at any level: other people's messages, thinking, and what a tool was given or gave back on a run that isn't yours. Essential sends no paths, no tool inputs or outputs, no commands, and nothing about your agents' sessions beyond their calls to Beluga's tools. On sends the text as you and your agent wrote it, and your tools' arguments and results as they were, masked: a path, a command or the part of a file a tool read goes too, with secrets taken out and the home folder replaced. To keep a project's commands and files out, leave that project out (above), or use Essential.

## How it's sent

Data is batched and sent about every 30 seconds to Ratel's `/v1/traces` and `/v1/logs`, as OTLP JSON.

- A failed send waits longer each time and keeps only what didn't go.
- The queue is capped, and the oldest items go first.
- If Ratel refuses a key, for example because it was revoked, sending to that project stops until Beluga starts again. The other project keeps going. This is how a release's statistics can be switched off for everyone, one project or both, without an update.
