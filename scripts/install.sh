#!/bin/sh
# Beluga on a server (Linux or macOS), with nothing to install first and no sudo:
#
#   curl -fsSL https://github.com/beluga-labs/beluga/releases/latest/download/install.sh | sh
#
# Puts Beluga (with its own Node) in ~/.beluga/server and links `beluga` into ~/.local/bin.
# Run it again (or `beluga update`) to update in place; a running Beluga is restarted on the new one.
#   BELUGA_VERSION=v2.1.0-mac   that release instead of the latest
#   BELUGA_DOWNLOAD_URL=…       the tarball from elsewhere (a mirror, file:// in CI)
#   BELUGA_BIN_DIR=…            where to link `beluga` (default ~/.local/bin)
set -eu

REPO=beluga-labs/beluga

say() { printf '%s\n' "$*"; }
fail() {
  printf 'Beluga could not be installed: %s\n' "$*" >&2
  exit 1
}

# Everything in a function, so a download cut short runs nothing.
main() {
  case $(uname -s) in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "Beluga's server runs on Linux and macOS, not $(uname -s)." ;;
  esac
  case $(uname -m) in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "Beluga runs on x64 and arm64 computers, not $(uname -m)." ;;
  esac
  # A Mac that reports x64 under Rosetta is an Apple silicon one.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi

  file=beluga-server-$os-$arch.tar.gz
  if [ -n "${BELUGA_DOWNLOAD_URL:-}" ]; then
    url=$BELUGA_DOWNLOAD_URL
  elif [ -n "${BELUGA_VERSION:-}" ]; then
    url=https://github.com/$REPO/releases/download/$BELUGA_VERSION/$file
  else
    url=https://github.com/$REPO/releases/latest/download/$file
  fi

  home_dir=${BELUGA_HOME:-$HOME/.beluga}
  dest=$home_dir/server
  bin_dir=${BELUGA_BIN_DIR:-$HOME/.local/bin}
  mkdir -p "$home_dir"
  # Unpacked beside where it goes (the same disk), so swapping it in is a rename.
  tmp=$(mktemp -d "$home_dir/.install.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT INT TERM

  say "Downloading Beluga for ${os}-${arch}…"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --progress-bar -o "$tmp/$file" "$url" || fail "couldn't download $url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --show-progress -O "$tmp/$file" "$url" || fail "couldn't download $url"
  else
    fail "it needs curl or wget to download itself. Install one, then run this again."
  fi
  tar -xzf "$tmp/$file" -C "$tmp" || fail "the download isn't a Beluga bundle (try again; it may have been cut short)"
  [ -x "$tmp/beluga/bin/beluga" ] || fail "the download has no beluga command in it"
  "$tmp/beluga/node/node" --version >/dev/null 2>&1 || fail "its Node doesn't run on this computer (Linux needs glibc 2.28 or later: Ubuntu 20.04, Debian 10, RHEL 8 and newer)"

  # Beluga running from the old copy: stop it, swap, start it on the new one.
  was_running=0
  if [ -x "$dest/bin/beluga" ] && "$dest/bin/beluga" status >/dev/null 2>&1; then
    was_running=1
    "$dest/bin/beluga" stop >/dev/null 2>&1 || true
  fi
  rm -rf "$dest.old"
  if [ -d "$dest" ]; then mv "$dest" "$dest.old"; fi
  mv "$tmp/beluga" "$dest"
  rm -rf "$dest.old"

  mkdir -p "$bin_dir"
  ln -sf "$dest/bin/beluga" "$bin_dir/beluga"
  say "Installed $("$dest/bin/beluga" version) in $dest"
  if [ "$was_running" = 1 ]; then
    if "$dest/bin/beluga" up >/dev/null 2>&1; then
      say "Beluga was running: it's running again, on the new version."
    else
      say "Beluga was running but didn't start again: \`beluga logs\` says why."
    fi
  fi

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *)
      say ""
      case ${SHELL:-} in
        */zsh) rc=~/.zshrc ;;
        */bash) rc=~/.bashrc ;;
        *) rc=~/.profile ;;
      esac
      say "$bin_dir isn't on your PATH yet. Add it (then open a new terminal):"
      say "  echo 'export PATH=\"$bin_dir:\$PATH\"' >> $rc"
      ;;
  esac
  if [ "$was_running" = 0 ]; then
    say ""
    say "Next: \`beluga setup\` (Claude sign-in, a project, your phone), or \`beluga up\` to just start it."
  fi
}

main "$@"
