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
# Node 22.5 or newer is required. On an older runtime the engine falls back to
# better-sqlite3 if it happens to be installed, but that is a courtesy, not the
# supported path.

set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
APP_NAME="RepoDeck"
APP="$ROOT/dist/$APP_NAME.app"

# ── the node the app will actually run ───────────────────────────────────────
# Same lookup order as EngineLocator, so the build verifies what ships.
pick_node() {
  if [[ -n "${REPODECK_NODE:-}" && -x "${REPODECK_NODE}" ]]; then
    echo "$REPODECK_NODE"; return
  fi
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [[ -x "$candidate" ]] && { echo "$candidate"; return; }
  done
  command -v node || true
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
  echo "⚠ ${NODE_VERSION} has no node:sqlite. The engine will need better-sqlite3;"
  echo "  install Node 22.5+ (brew install node) for the supported path."
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
rsync -a --delete --exclude '.git' "$ROOT/engine/" "$APP/Contents/Resources/engine/"

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
