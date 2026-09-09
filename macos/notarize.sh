#!/usr/bin/env bash
#
# Sign, notarise and staple RepoDeck.app for distribution beyond this Mac.
#
#   ./notarize.sh "Developer ID Application: Your Name (TEAMID)" "profile-name"
#
# `profile-name` is a notarytool keychain profile created once with:
#   xcrun notarytool store-credentials "profile-name" \
#     --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
#
# Locally built copies do not need any of this — they are ad-hoc signed and run
# fine. Notarisation only matters when someone else has to open the app.

set -euo pipefail

IDENTITY="${1:-}"
PROFILE="${2:-}"
[[ -n "$IDENTITY" && -n "$PROFILE" ]] || {
  echo "usage: ./notarize.sh \"Developer ID Application: … (TEAMID)\" <notarytool-profile>"
  exit 2
}

cd "$(dirname "$0")"
APP="$(cd .. && pwd)/dist/RepoDeck.app"
[[ -d "$APP" ]] || { echo "✗ $APP not found — run ./build-app.sh first"; exit 1; }

ENTITLEMENTS="$(mktemp -t repodeck-entitlements).plist"
cat > "$ENTITLEMENTS" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- RepoDeck spawns node, runs git, and starts the user's own dev servers. -->
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.automation.apple-events</key><true/>
</dict>
</plist>
PLIST

echo "▶ Signing"
# Nested code first, then the bundle: codesign requires inside-out ordering.
find "$APP/Contents/Resources" -type f \( -perm -u+x -o -name '*.node' -o -name '*.dylib' \) -print0 |
  while IFS= read -r -d '' binary; do
    codesign --force --timestamp --options runtime --sign "$IDENTITY" "$binary" >/dev/null
  done

codesign --force --timestamp --options runtime \
  --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$APP"

codesign --verify --deep --strict --verbose=2 "$APP"

echo "▶ Packaging for notarisation"
ZIP="$(dirname "$APP")/RepoDeck.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"

echo "▶ Submitting (this waits for Apple)"
xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait

echo "▶ Stapling"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"

rm -f "$ZIP" "$ENTITLEMENTS"
echo "✅ Notarised: $APP"
