#!/usr/bin/env bash
#
# Build a distributable RepoDeck.dmg.
#
#   ./make-dmg.sh            build the app first, then package it
#   ./make-dmg.sh --skip-build
#
# RepoDeck is not notarized. Notarization means shipping every build to Apple
# for approval, which needs a paid Developer ID and turns a two-minute release
# into a queue. The app is ad-hoc signed instead, which is enough for macOS to
# run it — once the quarantine flag that Safari and Finder attach to downloads
# has been removed.
#
# So the DMG carries its own remover: a "Remove quarantine" script the user runs
# once after dragging the app across. The one-line terminal installer does the
# same thing automatically, which is why it is the recommended path.

set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
APP="$ROOT/dist/RepoDeck.app"
DMG="$ROOT/dist/RepoDeck.dmg"
STAGE="$ROOT/dist/dmg-stage"
VOLUME="RepoDeck"

if [[ "${1:-}" != "--skip-build" ]]; then
  ./build-app.sh
fi

[[ -d "$APP" ]] || { echo "✗ $APP not found — run ./build-app.sh"; exit 1; }

echo "▶ Staging"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/RepoDeck.app"
ln -s /Applications "$STAGE/Applications"

# The one thing a user must do that a drag-and-drop cannot express.
cat > "$STAGE/Remove quarantine.command" <<'INNER'
#!/bin/bash
# RepoDeck is ad-hoc signed rather than notarized, so macOS marks it as
# downloaded and refuses to open it until that mark is cleared. This clears it.
set -e
APP="/Applications/RepoDeck.app"
if [[ ! -d "$APP" ]]; then
  echo "RepoDeck is not in /Applications yet."
  echo "Drag RepoDeck onto the Applications folder first, then run this again."
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
echo "Done — RepoDeck will now open normally."
open "$APP"
INNER
chmod +x "$STAGE/Remove quarantine.command"

cat > "$STAGE/READ ME FIRST.txt" <<'INNER'
RepoDeck
========

1. Drag RepoDeck onto the Applications folder.
2. Double-click "Remove quarantine.command".

That second step exists because RepoDeck is not notarized by Apple. Notarization
requires a paid Apple Developer account and a round trip to Apple for every
build. The app is signed locally instead, which macOS accepts — but it still
flags anything downloaded from the internet until that flag is cleared, which is
all the script does.

Prefer one command? This does both steps and keeps the app updated:

  curl -fsSL https://raw.githubusercontent.com/XPro-Gamer-Rhine/RepoDeck/main/install.sh | bash

Requires macOS 14+, Xcode Command Line Tools, and Node.js 22.5+.
INNER

echo "▶ Building the disk image"
hdiutil create \
  -volname "$VOLUME" \
  -srcfolder "$STAGE" \
  -ov -format UDZO \
  -fs HFS+ \
  "$DMG" >/dev/null

rm -rf "$STAGE"

SIZE="$(du -h "$DMG" | cut -f1 | tr -d ' ')"
echo "✅ Built: $DMG ($SIZE)"
echo "   Users drag the app across, then run \"Remove quarantine.command\" once."
