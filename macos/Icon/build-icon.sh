#!/usr/bin/env bash
# Render the 1024px icon, expand it to a full .iconset, and compile AppIcon.icns.
# Output: macos/AppIcon.icns
set -euo pipefail
cd "$(dirname "$0")"

MASTER="icon_1024.png"
ICONSET="AppIcon.iconset"
OUT="../AppIcon.icns"

echo "▶ Rendering master icon…"
swift make-icon.swift "$MASTER"

echo "▶ Building iconset…"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
gen() { sips -z "$2" "$2" "$MASTER" --out "$ICONSET/$1" >/dev/null; }
gen icon_16x16.png        16
gen icon_16x16@2x.png     32
gen icon_32x32.png        32
gen icon_32x32@2x.png     64
gen icon_128x128.png      128
gen icon_128x128@2x.png   256
gen icon_256x256.png      256
gen icon_256x256@2x.png   512
gen icon_512x512.png      512
cp "$MASTER" "$ICONSET/icon_512x512@2x.png"

echo "▶ Compiling icns…"
iconutil -c icns "$ICONSET" -o "$OUT"
echo "✅ $OUT"
