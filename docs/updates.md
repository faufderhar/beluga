# Beluga for Mac updates

Beluga for Mac updates itself from GitHub Releases, and its engine (the daemon it bundles) comes with it.

## Klaud is now Beluga

Copies installed as Klaud update to Beluga like any other version: the old release URL redirects to the Beluga repo, so they find the Beluga build on their own. After the update, `~/.klaud` moves to `~/.beluga` (with a link back), and old `klaud://` links still open.

## The repo moved to beluga-labs

The repo moved from `kayraucklnc/beluga` to `beluga-labs/beluga`. Copies built before the move still read `https://github.com/kayraucklnc/beluga/releases/latest/download/latest.json`, and GitHub redirects that to the new repo, so they keep updating. The redirect only lasts while nothing takes the old name: never create a repo called `beluga` under `kayraucklnc`, and never rename or delete that account. The app id `io.github.kayraucklnc.beluga` stays as it is, since changing it would orphan installed apps' data, notification permissions and background service.

## What you see

- **When it looks.** Beluga checks for a new version at launch (unless it checked less than an hour ago) and every 4 hours while it runs. After the Mac wakes, it checks if a check is overdue. A failed check is retried after an hour. The times are in `update_rules.rs`. You can also check by hand: **Beluga › Check for Updates…**, or **Check Now** in Settings › General › Updates (also in Settings › About).
- **What happens when it finds one.** The update downloads in the background and its signature is verified. Then a small pill appears at the bottom of the sidebar, "Beluga 0.5 is ready". If the sidebar is hidden, the pill sits in the window's corner. Clicking the pill opens a short sheet with the release notes and three choices:
  - **Restart Now** installs the update and reopens Beluga where you were (the same workspace, project or place).
  - **Update When Idle** installs once all of these are true:
    - No agent run is working or queued.
    - No program is running in Beluga's terminals. A shell sitting at its prompt doesn't count.
    - Nobody is in your room, and you aren't in someone else's.
    - You haven't touched the Mac for 10 minutes.

    Beluga then reopens quietly. If its window wasn't in front, it stays hidden in the menu bar and doesn't take focus.
  - **Later** installs the update the next time you quit Beluga.
- **The Updates settings** (Settings › General › Updates) are two switches:
  - **Update automatically** (on for a new install; earlier installs keep what they had, which was off unless you turned it on): a downloaded update installs by itself once you're idle (as with *Update When Idle* above), and Beluga reopens in the background. When it's off, you get the pill and choose.
  - **Check for updates** (on by default): when it's off, Beluga checks only when you click **Check Now**. Turning it off turns Update automatically off too, and turning Update automatically on turns it back on.

  Together they are the shell's `mode` in `updates.json`: `idle` (both on), `ask` (only checking) or `off`. The sheet's "Update automatically from now on" box is the first switch. A new install (no `updates.json`, and nothing else in its Application Support folder yet, such as `.window-state.json`) starts on `idle` and writes it right away; an existing `updates.json` is read as it is (no `mode` in it still means `ask`), and an earlier install that never wrote one stays on `ask`.
- **Quitting.** A downloaded update always installs when you quit, unless updates are *Off*. Quitting still means quitting: Beluga doesn't reopen afterwards (on Windows the installer is told not to, #426), and the new version starts the next time you open Beluga.
- **After an update.** The pill says "Updated to 0.5 · What's new" once.

## The phone app

The Android app updates itself from the same releases (BLG-426, `packages/companion/lib/update.ts`, `modules/app-update`).

- **When it looks.** At launch, unless it looked less than an hour ago, and every 4 hours while the app is open (an hour after a failed look). It reads `https://api.github.com/repos/beluga-labs/beluga/releases/latest` and takes the asset named `Beluga-<version>.apk`. When that version is newer than the installed one, it has found an update.
- **Downloading.** On Wi-Fi the update downloads by itself, as on the Mac. On mobile data it waits until you tap Update Now, and the sheet says how many MB it is. The file is kept in the app's cache and checked before it's used. Its size and SHA-256 must match the release (GitHub's `digest`), and it must be Beluga (`sh.ratel.beluga`) with a higher `versionCode` than the installed app. A file that fails these checks is deleted.
- **What you see.** Under Home's greeting, a small pill says "Beluga 1.8.0 is ready" ("is out" while it isn't downloaded yet). Tapping it opens a sheet with the release notes, **Update Now** and **Later**. Settings has the same thing as a row on top while there's an update.
- **Installing.** Update Now hands the APK to Android's `PackageInstaller`. Beluga closes as the new version goes in, and on the next launch it says "Updated to Beluga X" once.
  - The first time, Android asks to allow installs from Beluga ("Install unknown apps"), then shows its own Install confirmation.
  - From Android 12, an app that may install apps can update itself without that confirmation (`USER_ACTION_NOT_REQUIRED`).
  - When Android still wants a tap and the app isn't in front, a notification carries the confirmation.
- **Settings › Advanced › Updates** has the Mac's two switches:
  - **Update automatically** (on by default): a downloaded update installs once you leave the app, as the Mac waits until you're idle. It only does this when it can install without asking (Android 12+, installs allowed). If installs aren't allowed, a row there opens that Android setting. An update that went in while you were away posts "Beluga updated to X" (tap: open it and link again), because updating ends the link and Stay connected with it.
  - **Check for updates** (on by default): with it off, the app looks only when you tap **Check Now**. Turning it off turns Update automatically off too.
- **Releasing.** Raise `android.versionCode` in `packages/companion/app.json`, build with `npm run apk` in `packages/companion`, and attach both files from `dist/` as they are named: `Beluga-<version>.apk` (the name the app looks for) and `Beluga-Link.apk`.

## The phone app's signing key

Both phone apps, Beluga (`sh.ratel.beluga`) and Beluga Link (`sh.ratel.beluga.control`), are signed with Beluga's own key (BLG-430). Before that they were signed with the Expo template's public debug key. The key matters three ways:

- Android installs an update only over an app signed with the same key.
- Link and the app trust each other only when their keys match (`checkSignatures`).
- Nobody else can make an APK that installs over Beluga.

- **Where it is.** `~/.beluga-release/beluga-android.p12` (alias `beluga`) on the maintainer's Mac. Its password is in the login Keychain as `beluga-android-release`. Neither is ever in the repo. The certificate's SHA-256 is in [packages/companion/signing.json](../packages/companion/signing.json).
- **Keep a copy.** Back up both the file and the password (a password manager holds both). If the key is lost, no installed phone can be updated again, only uninstalled and installed afresh.
- **How it's used.** `npm run apk` ([scripts/build-apk.mjs](../packages/companion/scripts/build-apk.mjs)) reads the password from the Keychain, runs a clean prebuild and `assembleRelease` with `BELUGA_ANDROID_KEYSTORE` / `BELUGA_ANDROID_KEY_PASSWORD`, then refuses any APK whose certificate isn't the one in `signing.json`. Two places apply the key: `plugins/release-signing.js` for the app and `modules/phone-control/addon/build.gradle` for Link. A release build without those variables is signed with the debug key and gradle warns about it. Such a build is fine for your own phone, never for a release.
- **The switch (once).** Phones installed before the switch carry the debug key and can't take the new APK as an update. They uninstall Beluga and Beluga Link, install the new release, and pair again. The release notes for that version must say so. **Set Up Beluga Link** on the Mac replaces a Link whose key doesn't match the app's on its own (it compares `dumpsys package` signers, and uninstalls Link when `install -r` says `INSTALL_FAILED_UPDATE_INCOMPATIBLE`). A plain `adb install -r` of the new app over the old one fails the same way: `adb uninstall sh.ratel.beluga` first.


## What an update restarts

Installing restarts Beluga's engine, the daemon that the Mac app bundles. The new app runs its own daemon:

- On launch, a kept-alive daemon (one that a Mac app started) with a different version is stopped and replaced.

**Kept** (on disk in `~/.beluga`):

- projects, worktrees and workspaces
- each workspace's conversation
- each workspace agent's session, which resumes with its context
- settings and trust
- your identity
- friends, groups, messages and presence on the Beluga network, which reconnects by itself

**Lost:**

- Agent runs in progress and queued messages.
- Terminals and their scrollback. The shells start again.
- The room chat (it lives only in memory).
- The room-level agent's context.
- Friends connected to your room. They drop out, and the **invite link changes**: each start makes a new room secret. They need the new link.
- If you had joined a friend's room, you're back in your own.
- The first time a workspace is opened after the restart, its history loads again.

That is why *Update When Idle* waits for the agent, the terminals and the room.

## Claude Code between Beluga updates

New Claude models (a new Opus) come with a newer Claude Code, and Beluga keeps it current by itself, with nothing to click and no restart (`src/agent/claude-code-updates.ts`):

- A minute after it starts, then every six hours, Beluga asks npm for the newest Claude Code package in the line the build pinned (`0.3.x` for a build pinned to `0.3.301`). Another line waits for a Beluga update, since the build's Agent SDK may not speak to it.
- A newer one is downloaded next to the pinned one and checked against npm's sha512 integrity, the same check as the pinned download.
- It's then started once with the build's own SDK, asking for its models, with no message sent. Only one that answers is used. One that doesn't is noted in `~/.beluga/claude-code/skipped.json` and never tried again.
- From then on each new run, the Terminal view and sign-in use it (`~/.beluga/claude-code/current.json` names it), and the model picker asks it for its models again. A run already going finishes on the one it started with. The pinned Claude Code always stays on disk as the fallback.

Setting `BELUGA_CLAUDE_CODE_UPDATES=off`, or running your own Claude Code with `BELUGA_CLAUDE_PATH`, turns this off.

## Your other computers

Your app and each computer you added speak the same app protocol. A computer on another version
is still listed, read-only, with a line saying which side to update: **Update It** when the
computer is the older one. Update It runs `beluga update` there, which restarts that computer's
Beluga, so it never stops work by surprise: when something runs there (an agent working, a program
in a terminal) it says what, and you choose to update once that's done or now.

Each release's `latest.json` says which protocol it speaks (`ipc`). When an update would leave a
computer unable to connect, the update sheet names it and offers **Update … First**.

## Releasing

Releases are made from the maintainer's Mac, not CI: there's no workflow that publishes anything.
GitHub Actions only checks pull requests (`.github/workflows/ci.yml`, `mac.yml`).

**Beluga for Mac** (tags `v<version>-mac`), from an up-to-date main:

```sh
cd packages/mac
npm run release -- --set-version 0.8.0          # tauri.conf.json + package.json; commit it (in the PR)
npm run release -- --notes ../../notes.md --dry-run   # build and write latest.json, upload nothing
npm run release -- --notes ../../notes.md       # build, then gh release create … --latest
```

Installed copies read `https://github.com/beluga-labs/beluga/releases/latest/download/latest.json`. The release marked *latest* must therefore carry `latest.json`.

The script ([scripts/release-mac.mjs](../scripts/release-mac.mjs)) does the following:

1. Refuses a version that isn't newer than GitHub's latest release.
2. Builds with `npm run app:build`, signing the update, and makes the `.dmg` (`packages/mac/scripts/make-dmg.mjs`).
3. Writes `latest.json` with the version, notes, `pub_date`, and `platforms["darwin-aarch64"]`. That entry holds the signature and the URL of the `.app.tar.gz` asset.
4. Creates the release, or updates it if it exists, and marks it latest.

The app's version is `version` in [packages/mac/src-tauri/tauri.conf.json](../packages/mac/src-tauri/tauri.conf.json); the window reads it from there. `packages/mac/package.json` must match, and a test checks that.

## The signing key

Updates are signed with a minisign key, separate from Apple's Developer ID.

- **Public key:** `plugins.updater.pubkey` in tauri.conf.json. An update that doesn't verify against it is never installed. `requireSignedVersion` is on, so the version in `latest.json` must also match the version that was signed.
- **Private key:** `~/.tauri/beluga-updater.key` on the maintainer's Mac (mode 0600, no password; the release script also finds it under its name from before the rename). Never commit it or paste it anywhere. If it is lost, installed copies can't be updated any more, so keep a backup in a password manager.

## The code-signing certificate

macOS keeps Screen Recording and the other privacy permissions for an app's *designated requirement*. An ad-hoc signature's requirement is the hash of that one build (`designated => cdhash H"…"`), so each update would look like a new app and lose them. The release script therefore signs the app with the self-signed **Beluga Self-Signed** certificate in the maintainer's login keychain (`security find-identity -v -p codesigning`). The requirement then names the identifier and that certificate, and both stay the same from release to release. The script refuses to publish a build whose requirement is still a cdhash.

- `$APPLE_SIGNING_IDENTITY` picks another certificate, for example a Developer ID once there is one (BLG-195). Moving to a new certificate makes everyone grant the permissions once more.
- `--ad-hoc` releases without a certificate, the way releases up to 1.4.1 were signed, and updates lose their permissions again.
- Keep a backup of the certificate and its private key (Keychain Access › Export, `.p12`) in a password manager. A new certificate means one more grant for everyone.
- Gatekeeper treats it like an ad-hoc build: the first launch of a downloaded copy still needs Open Anyway. Updates through the app don't.

## Trying an update locally

Debug builds can be pointed at a local server, so the whole flow can be tried without GitHub:

1. Build an older and a newer version with `tauri build --debug --bundles app`. For both builds, use a `--config` that changes the identifier and the `beluga://` scheme (so they don't touch your installed Beluga) and sets `plugins.updater.dangerousInsecureTransportProtocol`. Sign the newer build with `TAURI_SIGNING_PRIVATE_KEY`.
2. Serve the newer build's `.app.tar.gz` and a `latest.json` (written with `latestJson` from the release script) over `http://127.0.0.1`.
3. Start the older app with these variables:
   - `BELUGA_HOME=<temp dir>`
   - `BELUGA_UPDATE_ENDPOINT=http://127.0.0.1:<port>/latest.json`
   - `BELUGA_UPDATE_IDLE_SECS=0` (to skip the 10 minutes)

   Run it from its real path (`/private/tmp/…`, not `/tmp/…`); the updater refuses symlinked paths.

Both variables are read only by debug builds.
