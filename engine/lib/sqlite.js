"use strict";

// Storage, without a native module.
//
// The engine originally used better-sqlite3. That works, but it is compiled
// against one specific Node ABI: build the app against the node on your PATH,
// ship it, let Homebrew upgrade node underneath it, and the engine dies at
// startup with ERR_DLOPEN_FAILED. Bundling a matching interpreter does not fix
// it either — Homebrew's node links against a dozen keg-relative dylibs and
// does not survive being copied.
//
// Node 22.5 shipped `node:sqlite`, and 24 made it stable. Using it removes the
// entire class of problem: there is nothing to compile, so there is nothing to
// mismatch. better-sqlite3 is kept as an optional fallback for older runtimes,
// behind the same small surface, so neither the schema nor a single query has
// to know which one it is talking to.

const BETTER_SQLITE_SURFACE = ["prepare", "exec", "pragma", "transaction", "close"];

/** Coerce sqlite's BigInt row ids to plain numbers, which the rest of the engine assumes. */
function normalizeRunResult(result) {
  if (!result) return { changes: 0, lastInsertRowid: 0 };
  const toNumber = (v) => (typeof v === "bigint" ? Number(v) : v ?? 0);
  return {
    changes: toNumber(result.changes),
    lastInsertRowid: toNumber(result.lastInsertRowid),
  };
}

/**
 * Adapts a `node:sqlite` DatabaseSync to the slice of the better-sqlite3 API
 * this engine actually uses.
 */
function adaptBuiltin(database) {
  const statements = new Map();

  const prepare = (sql) => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = database.prepare(sql);
      // Our inserts use @named parameters; accept plain object keys for them.
      if (typeof statement.setAllowBareNamedParameters === "function") {
        statement.setAllowBareNamedParameters(true);
      }
      statements.set(sql, statement);
    }
    return {
      run: (...args) => normalizeRunResult(statement.run(...args)),
      get: (...args) => statement.get(...args),
      all: (...args) => statement.all(...args),
    };
  };

  let depth = 0;

  return {
    prepare,
    exec: (sql) => database.exec(sql),

    /** better-sqlite3 spells these as `pragma("journal_mode = WAL")`. */
    pragma: (statement) => database.exec(`PRAGMA ${statement};`),

    /**
     * A transaction wrapper with the same shape better-sqlite3 has: it returns
     * a function, and calling that function runs the body atomically. Nesting
     * is handled with savepoints so an inner transaction cannot commit the
     * outer one out from under it.
     */
    transaction: (fn) =>
      (...args) => {
        const nested = depth > 0;
        const name = `rd_sp_${depth}`;
        database.exec(nested ? `SAVEPOINT ${name};` : "BEGIN;");
        depth++;
        // Exactly one decrement, in a finally. The earlier version decremented on
        // the way out of the try AND again in the catch, so a COMMIT that itself
        // threw drove the counter negative — after which every later transaction
        // mistook nesting for top level and issued BEGIN inside an open one.
        try {
          const result = fn(...args);
          database.exec(nested ? `RELEASE ${name};` : "COMMIT;");
          return result;
        } catch (err) {
          try {
            database.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name};` : "ROLLBACK;");
          } catch {
            // The rollback failing would mask the real error; the original wins.
          }
          throw err;
        } finally {
          depth--;
        }
      },

    close: () => database.close(),
    driver: "node:sqlite",
  };
}

function openBuiltin(file) {
  // Not destructured at module scope: on Node 20 this require throws, and that
  // is a fallback, not a crash.
  const { DatabaseSync } = require("node:sqlite");
  return adaptBuiltin(new DatabaseSync(file));
}

function openBetterSqlite(file) {
  const Database = require("better-sqlite3");
  const database = new Database(file);
  for (const method of BETTER_SQLITE_SURFACE) {
    if (typeof database[method] !== "function") {
      throw new Error(`better-sqlite3 is missing ${method}()`);
    }
  }
  database.driver = "better-sqlite3";
  return database;
}

/**
 * Open the database, preferring the built-in driver.
 *
 * Throws with something actionable rather than a dyld trace when neither
 * driver is available — that message ends up in front of the user.
 */
function open(file) {
  const problems = [];

  try {
    return openBuiltin(file);
  } catch (err) {
    problems.push(`node:sqlite — ${err.message}`);
  }

  try {
    return openBetterSqlite(file);
  } catch (err) {
    problems.push(`better-sqlite3 — ${err.message}`);
  }

  throw new Error(
    `RepoDeck could not open its database with any SQLite driver.\n` +
      `Node ${process.version} is in use; node:sqlite needs Node 22.5 or newer.\n` +
      problems.map((p) => `  · ${p}`).join("\n"),
  );
}

module.exports = { open };
