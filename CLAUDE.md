# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Beluga

The engine (`src/`, the daemon) and its two screens: the Mac app (`packages/mac`) and the phone
companion (`packages/companion`). Both screens drive the same core through `src/ipc/api.ts`.
How it fits together: `docs/how-it-works.md`.

## Commands

Run `npm install` at the root and in `packages/mac` (the root typecheck reads the Mac app's shared
files), and in `packages/companion` for phone work. There is no linter or formatter: `tsc` and the
tests are the gate.

```bash
# Repo root
npx vitest run tests/foo.test.ts              # one file
npx vitest run tests/foo.test.ts -t "name"    # one test
npm run typecheck                             # src/ and tests/ only; each package has its own
npm run test:coverage                         # thresholds in vitest.config.ts

# The Mac UI against the demo (mock agents, pretend friends and services), in two terminals
export BELUGA_HOME=$(mktemp -d) BELUGA_ALLOW_ORIGINS=http://localhost:1420
npm run dev                                   # repo root: the demo daemon
cd packages/mac && npm run dev                # same BELUGA_HOME: http://localhost:1420

# packages/mac
npm run app:dev                               # the native app, running the engine from this repo
npm run e2e -- earnings --project=app         # Playwright against the demo; always through npm run e2e
npm run sidecar                               # needed before cargo: the bundled Node and daemon

# packages/mac/src-tauri
cargo clippy --all-targets -- -D warnings && cargo test

# packages/companion
npm run web                                   # the phone app in a browser: "Try the demo" when pairing
npm run typecheck:worklet                     # the link worklet
```

- Vitest runs take one of two machine-wide slots (`scripts/test-lock.mjs`, `KLAUD_TEST_SLOTS=0` turns
  it off), so "waiting for a unit-test slot" is another worktree's run, not a hang. E2e runs are one
  at a time (`scripts/e2e-lock.mjs`).
- Anything that starts a daemon by hand needs a throwaway `BELUGA_HOME`, or it uses your real
  `~/.beluga`. Inside Beluga an inherited `KLAUD_HOME` is real data too. `tests/setup.ts` and the e2e
  config already handle this.
- Mac and server releases: `docs/updates.md` ("Releasing").

## Architecture

**A call goes in.** Every action a screen can take is one entry in `src/ipc/api.ts`: a zod tuple of
its arguments, grouped into `src/ipc/*-api.ts` with a matching `*-handlers.ts`.
`src/daemon/dispatch.ts` checks the arguments and runs the handler against the `Session`
(`src/core/session.ts`), which ties the network, projects and agents together. Adding a method means
the API entry, its handler, both coverage tables and a `docs/parity.md` row.

**State comes back.** The core's `Store` holds `DomainState` (`src/core/store.ts`). A screen gets a
snapshot and then every action, and replays them with the same reducer. `ClientStore`
(`src/client/client-store.ts`) composes that with the screen's own `ScreenState` into the `AppState`
it draws. The core never changes a screen directly: it sends `Intent`s (`src/core/intents.ts`) to the
screen that caused them, else to all of them.

**Four ways in, one core.**

| Who | Through | Allowed |
|---|---|---|
| Mac app, `beluga` CLI | loopback WebSocket with the `daemon.json` token (`src/daemon/server.ts`) | everything |
| Browsers | the daemon's web port serving the Mac UI build, per-browser sessions (`src/daemon/web*.ts`, `docs/web.md`) | nearly everything |
| Phone | paired device link (`src/companion/host.ts`), plus read models from `src/companion/views.ts` | `phone` methods in `src/companion/coverage.ts` |
| Your app on another computer | a Noise stream into the same accept path (`src/machines/`, `docs/machines.md`) | `drive` methods in `src/machines/coverage.ts` |

**Three protocols, easy to mix up.** `src/protocol.ts` is between people (rooms, friends),
`src/ipc/protocol.ts` is screen to daemon, and `src/companion/protocol.ts` is phone to Mac.

**Agents.** `src/agent/runtime/types.ts` is the seam: `AgentRuntime` has Claude, Codex and OpenCode
implementations under `src/agent/runtime/`, and the session layer reads a runtime's capabilities
rather than assuming Claude. Every Claude Agent SDK import stays in `src/agent/runtime/claude/`.
Beluga's own tools for agents are `src/agent/*-tools.ts`. The demo runs on `src/agent/mock*.ts` and
the scripted Codex and OpenCode.

**Features** live in `src/core/<feature>/` and are started by a `launch*` call from
`src/daemon/core.ts`. Shared schemas and pure logic are in `src/shared/`.

**The Mac app** is React in `packages/mac/src`, importing the engine through the `@beluga/*` alias
for `src/`, in a Tauri shell (`src-tauri/`). `src-tauri/src/daemon.rs` finds a running daemon or
starts the bundled one, which `scripts/build-sidecar.mjs` builds. `src/ui` is not a terminal UI: it
holds the render-agnostic menus, actions and models the Mac app draws.

**The phone** is an Expo app whose link runs in a Bare worklet (`worklet/link.ts`). It imports
`src/companion/protocol.ts` and the Mac's parsers rather than copying them. Its demo
(`lib/link/demo/`) answers as `src/companion/host.ts` does, so keep the two matching.

**Tests** are flat in `tests/` and cover the Mac's models (`tests/mac-*`) and the phone's views
(`tests/companion-*`) as well as the engine. They use real git, terminals and peer-to-peer links,
hence the 30 s timeouts. Browser flows are in `packages/mac/e2e`.

**Old names.** Beluga was Klaud: `KLAUD_*` variables, `~/.klaud` and `KLD-` ids are kept on purpose
for existing installs and worktrees. Some variables exist only under the old name.

## Keep the phone in step with the Mac

The Mac app moves fast; the phone must never fall behind silently. Whenever you change the
daemon or the Mac app, check the phone too, in the same change:

- **A new or changed API method** (`src/ipc/*-api.ts`): classify it in `src/companion/coverage.ts`
  as `phone` or `mac`, and in `src/machines/coverage.ts` as `drive` or `refuse` (the typecheck
  fails until you do both). `phone` only for what fits the phone:
  reading, answering, asking, chatting, and (BLG-42) a worktree's Files and Terminal. Never
  editing, diffs, git beyond Merge, or settings.
- **A change to what a screen shows** (conversations, sub-agents, outputs, plans, approvals,
  questions, friends' requests, chats, usage): update its view in `src/companion/views.ts`, and the
  phone screen that draws it in `packages/companion/app/`. Run `npx vitest run tests/companion-*`.
- **Something new that waits for the user** (a new kind of approval, question or decision): it
  must reach the phone as a `NeedsYou` item with its actions, and notify. A phone that doesn't know
  the kind shows a plain card, so add it to the phone's cards too.
- **The link's frames or the views' shape** (`src/companion/protocol.ts`): additive changes only
  within `COMPANION_PROTO.major`. A breaking change bumps the major, keeps the old one answered for a
  release, and is written up in `docs/companion.md`.
- What goes to the phone, and how (BLG-42):
  - **Source is read-only, and only in Files.** A worktree's own files go only through the
    companion's file gate (`src/companion/worktree-files.ts`): inside that worktree (links followed
    and checked again), never `isSecretPath`, read in 512 KB pages with secrets redacted. Nothing
    on the phone can save, format or otherwise change a file.
  - **Everywhere else, no code.** Outputs still go only through `isArtifact` and never
    `isSecretPath` (`src/companion/files.ts`); Claude's answers still go through `stripCode`.
  - **The terminal is interactive and shared with the Mac.** A worktree's terminals are the
    daemon's own PTY sessions, the ones the Mac's dock shows (`src/companion/terminals.ts`): the
    phone streams them and types into them, the session keeps the Mac's size, and who attached and
    how much they typed is logged (never what). Only terminals of your worktrees; gated by
    `SINCE.terminal`.
  - **Still never:** editing, diffs, git writes beyond Merge, settings, or secrets.
- The phone's look (`packages/companion/lib/theme.ts`): soft pastels and icons, never glows or
  neon. Headers and toolbars are solid with a hairline once scrolled, never a gradient fade. One main action on the surface; advanced options go behind the ••• / long-press sheet or
  Settings › Advanced, never as extra buttons.

## Also kept in step

- `docs/parity.md` lists every command, UI action, menu and API method with where the Mac shows it
  (`tests/parity.test.ts`).
- The core stays free of UI code (`tests/boundaries.test.ts`); what the screens import stays
  browser-safe (`tests/browser-safe.test.ts`), and `src/companion/protocol.ts` too: zod only.

## Releasing the phone app

- Build the APKs only with `npm run apk` in `packages/companion`. It signs both with Beluga's own key (`~/.beluga-release/`, password in the Keychain), checks them against `signing.json`, and writes `dist/Beluga-<version>.apk` and `dist/Beluga-Link.apk`. Attach both to the release under exactly those names: phones update themselves from `releases/latest` by looking for `Beluga-<version>.apk`.
- Never attach an APK from a plain `./gradlew assembleRelease`. It carries the debug key, so phones refuse it as an update and Beluga Link stops trusting the app.
- Raise `android.versionCode` in `packages/companion/app.json` every release.
- The first release with the new key (the one after 1.7.0) must tell phone users, once: uninstall Beluga and Beluga Link, install this version, pair again. More in `docs/updates.md` ("The phone app's signing key").

## Checks

`npm run typecheck`, `npx vitest run`, and in `packages/companion` and `packages/mac`: `npm run typecheck`.
CI also runs the Mac app's `npm run e2e`, and clippy and `cargo test` for its native shell.

Run the whole `npx vitest run` after your last change, before you commit. When every test passes on
a Mac it ends with a `Tested-on: macOS <tree>` line. Put that line, as it is, at the end of the
commit message, and commit every file it tested (nothing changed since the run). CI then skips its
macOS run for that commit (`scripts/local-pass.mjs`), and Linux and Windows still run there. No line
(a failure, part of the suite, a file changed during the run) means don't add one.
