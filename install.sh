#!/usr/bin/env bash
#
# One-line installer for RepoDeck.
#
#   curl -fsSL https://raw.githubusercontent.com/<you>/RepoDeck/main/install.sh | bash
#
# Clones (or updates) the repository into ~/.repodeck/src, builds the app from
# source, installs it to /Applications, and launches it. Re-run to update.

set -euo pipefail

REPO_URL="${REPODECK_REPO:-https://github.com/XPro-Gamer-Rhine/RepoDeck.git}"
SRC="${REPODECK_SRC:-$HOME/.repodeck/src}"
DEST="/Applications/RepoDeck.app"

say()  { printf '\033[1;36m▶\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$1"; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# ── prerequisites ────────────────────────────────────────────────────────────

[[ "$(uname -s)" == "Darwin" ]] || die "RepoDeck is a macOS app."

MACOS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
(( MACOS_MAJOR >= 14 )) || die "macOS 14 or newer is required (found $(sw_vers -productVersion))."

xcode-select -p >/dev/null 2>&1 || die "Xcode Command Line Tools are missing. Run: xcode-select --install"

command -v swift >/dev/null 2>&1 || die "Swift is missing. Run: xcode-select --install"

find_node() {
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [[ -x "$candidate" ]] && { echo "$candidate"; return; }
  done
  command -v node || true
}

NODE_BIN="$(find_node)"
[[ -n "$NODE_BIN" ]] || die "Node.js is missing. Run: brew install node"

NODE_VERSION="$("$NODE_BIN" -v)"
NODE_MAJOR="$(echo "${NODE_VERSION#v}" | cut -d. -f1)"
NODE_MINOR="$(echo "${NODE_VERSION#v}" | cut -d. -f2)"
if (( NODE_MAJOR < 22 )) || { (( NODE_MAJOR == 22 )) && (( NODE_MINOR < 5 )); }; then
  warn "Node ${NODE_VERSION} has no built-in SQLite. RepoDeck wants 22.5 or newer — brew install node"
fi

say "Node ${NODE_VERSION} at ${NODE_BIN}"

# ── source ───────────────────────────────────────────────────────────────────

if [[ -d "$SRC/.git" ]]; then
  say "Updating $SRC"
  git -C "$SRC" fetch --quiet origin
  git -C "$SRC" reset --hard --quiet origin/HEAD 2>/dev/null || git -C "$SRC" pull --quiet --ff-only
elif [[ -f "$(dirname "${BASH_SOURCE[0]}")/macos/build-app.sh" ]]; then
  # Running from a checkout already — build that instead of cloning again.
  SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  say "Building from $SRC"
else
  say "Cloning into $SRC"
  mkdir -p "$(dirname "$SRC")"
  git clone --quiet --depth 1 "$REPO_URL" "$SRC"
fi

# ── build ────────────────────────────────────────────────────────────────────

say "Installing engine dependencies"
(cd "$SRC/engine" && PATH="$(dirname "$NODE_BIN"):$PATH" npm install --silent)

say "Building the app (this takes a minute)"
(cd "$SRC/macos" && ./build-app.sh)

BUILT="$SRC/dist/RepoDeck.app"
[[ -d "$BUILT" ]] || die "The build did not produce $BUILT"

# ── install ──────────────────────────────────────────────────────────────────

if pgrep -f "RepoDeck.app/Contents/MacOS/RepoDeck" >/dev/null 2>&1; then
  say "Quitting the running copy"
  osascript -e 'tell application "RepoDeck" to quit' >/dev/null 2>&1 || true
  sleep 2
fi

say "Installing to $DEST"
rm -rf "$DEST"
cp -R "$BUILT" "$DEST"

# RepoDeck is ad-hoc signed rather than notarized. Notarization needs a paid
# Apple Developer ID and a round trip to Apple on every build; the app is signed
# locally instead. macOS still marks anything that arrived over the network as
# quarantined and refuses to open it, so clear that here — this is exactly what
# the user would otherwise be told to do by hand.
say "Clearing the download quarantine flag"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

say "Launching"
open "$DEST"

cat <<'DONE'

✅ RepoDeck installed — no security warning, because the installer cleared the
   quarantine flag for you.

Next:
  1. Connect GitHub — it can borrow your `gh auth login` token in one click.
  2. Settings → AI — add a Claude or OpenAI key, or point it at a local model.
  3. Add a repository by pasting its SSH or HTTPS URL.

Re-run this installer any time to update.
DONE
