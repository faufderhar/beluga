# Your own traces

Send your agents' traces to your own observability tools. Every turn, model request, tool call, token and cost goes there as OpenTelemetry, from every agent Beluga runs: Claude, Codex, OpenCode, Copilot, Antigravity and local models.

It's set up in **Settings › Traces**, and it's off until you connect a tool. It's separate from Beluga's [usage statistics](telemetry.md). Those go to Beluga's own projects at the level you chose. These go to your accounts, with your keys, whatever that level is. A build from source can send them too.

## The tools

| Tool | What you paste in | Where it goes |
| --- | --- | --- |
| **Ratel Cloud** | API key | `cloud.ratel.sh/v1/traces` |
| **Braintrust** | API key, project name, region | `api.braintrust.dev/otel` (EU: `api-eu`) |
| **PostHog** | Project API key (`phc_…`), region | LLM analytics' OpenTelemetry endpoint |
| **LangSmith** (LangChain) | API key, project (optional), region | `api.smith.langchain.com/otel` (EU, APAC) |
| **Arize** | API key, space ID, project; or a Phoenix address | `otlp.arize.com` (EU too), or your Phoenix |
| **Logfire** (Pydantic) | Write token, region | `logfire-us` or `logfire-eu.pydantic.dev` |
| **Sentry** | The project's DSN | The project's OTLP endpoint, worked out from the DSN |
| **New Relic** | Ingest license key, region | `otlp.nr-data.net` (EU, Japan) |
| **Datadog** | API key, site, ML app (optional) | LLM Observability on `otlp.<site>`, no Agent needed |
| **Langfuse** | Public and secret key, region or your own address | `/api/public/otel` on Langfuse Cloud (EU, US, Japan, HIPAA) or yours |
| **Databricks** | Workspace, access token, Unity Catalog spans table | MLflow traces in Unity Catalog |
| **Another OTLP endpoint** | Its traces address, and any headers | Any collector or tool that takes OTLP over HTTP |

Each tool's row links to its website. Its form says where to find its key and links to that tool's own guide. **Send Test** sends one small trace called "Beluga test" with what you typed and saves nothing, so you know the key and project work before you connect.

## What's sent

The same spans Beluga builds for its usage statistics, in the OpenTelemetry `gen_ai` shape that LLM tools read:

- an `invoke_agent` span for each turn, with the runtime, model, effort, tokens, cache tokens, cost and how it ended;
- a `chat` span for each model request, and an `execute_tool` span for each tool call under the request that asked for it. A sub-agent is its own `invoke_agent` span, with its own requests and tools under it;
- where it ran (project, branch, worktree, board task, pull request), waits for you, permission decisions, compactions and hooks.

For Claude, the per-request detail comes from Claude Code's own telemetry, which Beluga catches on your computer. Claude Code itself still sends nothing anywhere else.

**Send what you and your agent wrote** is on by default for each tool. It adds your prompts, the agent's answers, what each tool was given and what it gave back, and what a question asked you. These are only from runs that are yours: the ones you typed, and the ones Beluga started for you (a task's agent, a sentinel). A run a friend, a friend's agent or a guest asked for never sends them. Turn it off and only the shape of each turn goes: names, numbers and timings.

Secrets are always taken out first, the same way as for usage statistics ([how it's masked](telemetry.md#the-text-on-adds-and-how-its-masked)). That covers your saved variables, your projects' `.env` values, your endpoints' keys, these tools' own keys, and keys recognised by their shape.

A project you left out of usage statistics still sends to your own tools: leaving it out only keeps it from Beluga.

## How each tool shows it

Each tool reads OpenTelemetry a little differently. Beluga adds what each tool's own documentation asks for, to that tool's copy only. Nothing new is sent: it's the same turn, under the names that tool reads.

- **Every tool** gets the agent's answer as an attribute on the last model request. Most tools don't read span events, and Sentry drops them.
- **Every tool but Ratel** also gets these. Ratel reads Beluga's spans as they are.
  - **The root span:** the turn's prompt and answer, so trace lists show what was asked and what came back.
  - **Every span:** `session.id` and `user.id`. Your user is a random id kept on your computer, never your name or email.
  - **Each model request:** its cost, as `gen_ai.usage.cost`.
- **Braintrust:** the turn as a task, with its input and output, and each tool's input and output.
- **LangSmith:** the turn as a chain, a thread per conversation, the provider and model its cost needs, and each tool's input and output.
- **Langfuse:** the trace's input and output, with the repo, branch and board task as trace metadata.
- **Arize and Phoenix:**
  - OpenInference span kinds (agent, LLM, tool);
  - the turn's text on the root;
  - cached tokens under OpenInference's names, and each request's cost.
- **PostHog:**
  - your random id as the person, so traces aren't anonymous;
  - cached tokens marked as already part of the input, so they aren't priced twice;
  - each request's cost, and failed tools marked as errors.
- **Sentry:** each span's `sentry.op` (`gen_ai.chat`, `gen_ai.execute_tool`…), finish reasons in the form it reads, and each request's cost.
- **Logfire:** each request's cost as `operation.cost`, so agent runs total up. The tools the model had go on the agent span.
- **Datadog:** LLM Observability is switched on for the spans, and your ML app is the service's name.
- **New Relic:** no value is longer than the 4,095 characters it keeps. Long prompts and answers are shortened inside their JSON, so they still read as messages.
- **Databricks:** the turn's tokens summed on its root span, where MLflow reads them.

## Where the keys are kept

On this computer, in Beluga's file of your secrets (the same one as your variables and your endpoints' keys), readable only by you. Settings never shows a key again, only that one is saved: leave the field empty to keep it, or type a new one to replace it. **Disconnect** forgets a tool's keys.

## How it's sent

Spans are batched and sent about every 30 seconds as OTLP/HTTP protobuf. Every OTLP endpoint has to accept protobuf, and some (Databricks) accept nothing else. Each tool has its own queue:

- A failed send waits longer each time and tries again.
- If a tool refuses the key, Settings says **Key refused** and sending to that tool stops until you save it again. The other tools keep going.

Each tool's row says how it's doing: waiting for your next turn, sending (and when the last batch went), key refused, or not going through.
