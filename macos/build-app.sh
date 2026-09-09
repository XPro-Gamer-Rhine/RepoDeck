# Assemble "RepoDeck.app" — a self-contained bundle.
#
#   ./build-app.sh
#
# The engine is pure JavaScript: storage goes through Node's built-in
# `node:sqlite`, so there is no native module to compile and nothing that can
# fall out of step with the Node the app happens to find at run time. That also
# means there is no interpreter to bundle — Homebrew's node links against a
# dozen keg-relative dylibs and does not survive being copied anyway.
#
# Node 22.5 or newer is required, and the bundle deliberately does NOT carry a
# compiled better-sqlite3: a .node built here works only for this exact Node ABI
# and CPU, so shipping one hands anyone else a dyld trace instead of the engine's
# own message naming the version it needs. The fallback stays available to anyone
# who installs it themselves.

set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
APP_NAME="RepoDeck"
APP="$ROOT/dist/$APP_NAME.app"

# ── the node the app will actually run ───────────────────────────────────────
# Same lookup order as EngineLocator, so the build verifies what ships.
# Mirrors EngineLocator: prefer a runtime that has node:sqlite over merely the
# first one on the list, so the build verifies what the app will actually use.
capable() {
  local v major minor
  v="$("$1" -v 2>/dev/null)" || return 1
  v="${v#v}"
  major="${v%%.*}"; v="${v#*.}"; minor="${v%%.*}"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  (( major > 22 )) || { (( major == 22 )) && (( minor >= 5 )); }
}

pick_node() {
  if [[ -n "${REPODECK_NODE:-}" && -x "${REPODECK_NODE}" ]]; then
    echo "$REPODECK_NODE"; return
  fi
  local fallback=""
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$(command -v node || true)"; do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    capable "$candidate" && { echo "$candidate"; return; }
    [[ -z "$fallback" ]] && fallback="$candidate"
  done
  echo "$fallback"
}

NODE_BIN="$(pick_node)"
if [[ -z "$NODE_BIN" ]]; then
  echo "✗ Node.js not found. Install it first:  brew install node"
  exit 1
fi
NODE_VERSION="$("$NODE_BIN" -v)"
NODE_MAJOR="$(echo "${NODE_VERSION#v}" | cut -d. -f1)"
NODE_MINOR="$(echo "${NODE_VERSION#v}" | cut -d. -f2)"
echo "▶ Engine runtime: $NODE_BIN (${NODE_VERSION})"

if (( NODE_MAJOR < 22 )) || { (( NODE_MAJOR == 22 )) && (( NODE_MINOR < 5 )); }; then
  echo "✗ ${NODE_VERSION} has no node:sqlite, so this build cannot be verified"
  echo "  against the runtime it ships for. Install Node 22.5+ (brew install node)."
  exit 1
fi

if [[ ! -d "$ROOT/engine/node_modules" ]]; then
  echo "▶ Installing engine dependencies…"
  (cd "$ROOT/engine" && PATH="$(dirname "$NODE_BIN"):$PATH" npm install --silent)
fi

echo "▶ Building release binary…"
swift build -c release
BIN="$(swift build -c release --show-bin-path)/RepoDeck"

echo "▶ Assembling bundle at $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$BIN" "$APP/Contents/MacOS/RepoDeck"
cp Info.plist "$APP/Contents/Info.plist"

if [[ -f AppIcon.icns ]]; then
  cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
else
  echo "⚠ AppIcon.icns missing — run Icon/build-icon.sh first (the app still runs)"
fi

echo "▶ Copying engine…"
rsync -a --delete --exclude '.git' \
      --exclude 'node_modules/better-sqlite3' \
      --exclude 'node_modules/.package-lock.json' \
      --exclude 'node_modules/**/*.node' \
      --exclude 'node_modules/**/prebuilds' \
      --exclude 'node_modules/**/build/Release' \
      "$ROOT/engine/" "$APP/Contents/Resources/engine/"

# Nothing compiled may ride along: a native binary in the bundle is either
# useless on another machine or actively confusing.
if find "$APP/Contents/Resources/engine" -name '*.node' -print -quit | grep -q .; then
  echo "✗ A compiled .node slipped into the bundle:"
  find "$APP/Contents/Resources/engine" -name '*.node'
  exit 1
fi

echo "▶ Ad-hoc code signing…"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || \
  echo "⚠ codesign failed (the app will still run locally)"

# ── smoke test: the packaged engine has to actually boot ─────────────────────
echo "▶ Verifying the packaged engine…"
if echo '{"id":1,"method":"app.ping","params":{}}' | \
   "$NODE_BIN" "$APP/Contents/Resources/engine/index.js" daemon 2>&1 | grep -q '"pong":true'; then
  echo "  engine responds ✓"
else
  echo "✗ The packaged engine did not respond to app.ping. The app will not work."
  exit 1
fi

echo "✅ Built: $APP"
echo "   Launch with:  open \"$APP\""
