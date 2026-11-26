# Usage statistics: privacy notice

Last updated: 2026-11-19

This notice is for people who share usage statistics from Beluga. It follows Article 13 of the EU General Data Protection Regulation (GDPR). What each level sends, field by field, is in [Usage statistics](telemetry.md). This page says who gets it, why, for how long, and what you can do about it.

## Who is responsible

The controller is **Agentified S.r.l.**, Via Lorenzo Mascheroni 14, 20145 Milan, Italy. VAT 14664350965.

Write to **privacy@ratel.sh** for anything on this page.

## What we get

Nothing, unless you choose a level. Beluga picks none for you: Skip, or Finish with no level picked, is Off.

Sharing is voluntary. No law or contract requires it. If you choose Off, everything in Beluga works the same.

| Level | What's sent |
| --- | --- |
| **Off** | Nothing. |
| **Essential** | How Beluga's own features are used: the names of the actions screens take, calls to Beluga's own tools (names, durations, kinds of failure), the onboarding's steps, and this computer's kind (operating system, chip, memory, language, versions). No agent sessions, no text. |
| **On** | Essential, plus your agents' sessions: turns, models, tokens, cost, every tool call with what it was given and what came back, the text of your own conversations, and the names of your projects, branches and worktrees. Text, arguments and results are masked on your computer first. Names are sent as they are, not hashed. |

Every level that sends carries a random install id, made once on your computer. It doesn't hold your name or email, and Beluga never adds them. Claude Code's own account ids and email are dropped before anything is sent. Masking takes out secrets, emails and your home folder's name, but it can miss something.

**This is personal data, not anonymous data.** The install id ties everything from one computer together, and at On, project names, file paths and the text you typed can say who you are. The law calls this pseudonymous data, and the GDPR applies to it.

## Why

To understand how Beluga is used, and to make it better: which features to fix, build or drop.

We don't sell it. We don't use it for ads. We don't build a profile of you or make decisions about you with it. We commit not to use it to train AI models.

## On what legal basis

Your consent: Article 6(1)(a) GDPR. Reading and storing the install id on your computer also needs your consent under Article 122 of the Italian Privacy Code (Legislative Decree 196/2003).

You can withdraw it at any time: set **Settings › General › Usage statistics** to Off, or set Usage statistics to Off in the phone's **Settings**. Anything not sent yet is cleared. Withdrawal doesn't make what was sent before it unlawful.

The IP address your usage statistics come from is handled on another basis: our legitimate interest, Article 6(1)(f) GDPR, in keeping the service secure and available. That covers the rate limiting in memory and the load balancer logs (see [IP addresses](#ip-addresses)).

## Who receives it

**Ratel Cloud** (cloud.ratel.sh) receives and stores it. Beluga sends it straight there, with no CDN or proxy in front. Ratel Cloud is run by the controller itself, so nobody else gets your data as a controller.

These subprocessors help us run it:

| Name | Purpose | Location | Transfer safeguard |
| --- | --- | --- | --- |
| Amazon Web Services EMEA SARL | Hosting, load balancer, database (RDS PostgreSQL), application logs (CloudWatch), storage | Frankfurt, Germany (eu-central-1) | EU: none needed |
| Amazon Web Services EMEA SARL (Amazon Bedrock, Anthropic Claude models) | AI analysis of sessions (signals, labels, intents) | EU regions only | EU: none needed |
| OpenAI, L.L.C. | AI judging of tool choices and session quality | United States | EU-US Data Privacy Framework / Standard Contractual Clauses |
| Datadog, Inc. (EU site) | Operational monitoring of service logs (metadata only, no session content) | EU (datadoghq.eu) | EU: none needed |
| PostHog Inc. (EU Cloud) | Product analytics and error tracking of the service (metadata only) | EU | EU: none needed |

AI providers process the data only to provide the analysis and do not use it to train their models.

We tell you before we add a new subprocessor here.

## IP addresses

Ratel's ingest service does not store or log the IP address your usage statistics come from. It uses it only briefly, in memory, to limit request rates. Ratel's load balancer access logs (AWS, Frankfurt) keep it for up to 90 days for security.

We do this on the basis of our legitimate interest (Article 6(1)(f) GDPR): keeping the service secure and available, and protecting it from abuse. You can object to it (see [Your rights](#your-rights)).

Beluga itself adds no IP address and no computer name to what it sends.

## Transfers outside the EU

If a subprocessor handles data outside the European Economic Area, it does so only under Articles 44 and following of the GDPR: a country with an adequacy decision (for example a US company certified under the EU-US Data Privacy Framework), or the European Commission's Standard Contractual Clauses.

## How long we keep it

14 months from when it arrives. Then it's deleted, or aggregated so that it no longer says anything about one install.

## Your rights

You can ask us to:

- give you a copy of your data (access), and in a machine-readable form (portability);
- correct it (rectification);
- delete it (erasure);
- keep it but stop using it (restriction);
- stop using your IP address for security and rate limiting (objection, Article 21 GDPR). This right applies to that processing, because it rests on our legitimate interest;
- and you can withdraw your consent to the usage statistics at any time, as above. They rest on your consent, so withdrawal is the right that applies to them, not objection.

Write to privacy@ratel.sh. Data is kept under your install ID, not your name, so we can only find it if you send that ID. Find your install ID in Settings › General › Usage statistics and include it in your request. (It's also the `installId` in `~/.beluga/telemetry.json`.)

**Reset ID**, beside it, starts a new random ID. What was sent before stays linked to the old ID, so keep a copy of the old one if you want to make a request about that data.

If you think we handle your data wrongly, you can complain to the Italian data protection authority, the **Garante per la protezione dei dati personali** ([www.garanteprivacy.it](https://www.garanteprivacy.it)), or to the authority where you live or work.

## Builds from source

A build from source sends nothing. It never asks and never shows the setting. Neither does the demo. See [Who can send](telemetry.md#who-can-send).
