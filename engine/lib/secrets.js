"use strict";

// In-memory secret vault.
//
// The macOS app owns the Keychain. At launch — and whenever the user adds a
// token or an API key — it pushes `{ ref: value }` pairs down the stdio pipe
// with `app.secrets`. The database only ever stores the *ref* (a Keychain
// account name), never the value, so a copy of the sqlite file is worthless on
// its own and nothing secret survives the process exiting.

const vault = new Map();

function setAll(entries) {
  for (const [ref, value] of Object.entries(entries || {})) {
    if (value == null || value === "") vault.delete(ref);
    else vault.set(ref, String(value));
  }
  return { count: vault.size };
}

function clear() {
  vault.clear();
}

function get(ref) {
  if (!ref) return null;
  return vault.get(ref) ?? null;
}

/// Throws with a message the UI can act on, rather than failing deep inside git.
function require_(ref, what) {
  const value = get(ref);
  if (!value) {
    throw new Error(
      `${what} is not unlocked. Open RepoDeck's settings and re-authorise it, then try again.`,
    );
  }
  return value;
}

function has(ref) {
  return Boolean(get(ref));
}

module.exports = { setAll, clear, get, has, require: require_ };
