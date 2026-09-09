#!/usr/bin/env bash
#
# Check that what the engine returns is what the app can decode.
#
#   tools/contract-check/run.sh [repodeck-home]
#
# Drives a real engine against a real database, captures one payload per RPC,
# and decodes each with the exact type the app uses. A mismatch here is a screen
# that would silently show "no data".

set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
HOME_DIR="${1:-$HOME/Library/Application Support/RepoDeck}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

find_node() {
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [[ -x "$c" ]] && { echo "$c"; return; }
  done
  command -v node || true
}
NODE="$(find_node)"
[[ -n "$NODE" ]] || { echo "✗ Node.js not found"; exit 1; }

if [[ ! -f "$HOME_DIR/data/repodeck.db" ]]; then
  echo "✗ No RepoDeck database at $HOME_DIR"
  echo "  Add and index a repository first, or pass a different home directory."
  exit 1
fi

# The DTOs are copied rather than referenced so this stays a self-contained
# SwiftPM target, and copied on every run so it can never drift from the app.
cp "$ROOT/macos/Sources/RepoDeck/Models/DTOs.swift" Sources/contract-check/DTOs.swift
trap 'rm -rf "$WORK"; rm -f "$(pwd)/Sources/contract-check/DTOs.swift"' EXIT

echo "▶ Building the decoder"
swift build -c release >/dev/null
BIN="$(swift build -c release --show-bin-path)/contract-check"

echo "▶ Capturing payloads from $HOME_DIR"
REPODECK_HOME="$HOME_DIR" OUT="$WORK" "$NODE" capture.js

echo "▶ Decoding"
FAILED=0
while IFS=$'\t' read -r type file method; do
  if out="$("$BIN" "$type" "$WORK/$file" 2>&1)"; then
    printf '  ok   %-18s %s\n' "$type" "$method"
  else
    printf '  FAIL %-18s %s\n' "$type" "$method"
    printf '%s\n' "$out" | tail -n +2 | sed 's/^/       /'
    FAILED=1
  fi
done < <("$NODE" -e '
  const m = require(process.env.OUT + "/manifest.json");
  for (const e of m) console.log([e.type, e.file, e.method].join("\t"));
' OUT="$WORK" 2>/dev/null || OUT="$WORK" "$NODE" -e '
  const m = require(process.env.OUT + "/manifest.json");
  for (const e of m) console.log([e.type, e.file, e.method].join("\t"));
')

if [[ "$FAILED" == "1" ]]; then
  echo "✗ The engine returns something the app cannot decode."
  exit 1
fi
echo "✅ Every RPC payload decodes with the type the app uses."
