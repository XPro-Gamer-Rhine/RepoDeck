# Contract check

Decodes real engine output with the app's real DTOs.

A Codable mismatch between the engine and the app does not crash anything — it
makes a whole screen say "no data". That has happened once already in this
codebase (the knowledge graph reported "not built" over a graph that existed,
because one query returned `commit_count` where the DTO expected `merges`, and
the decode failure was swallowed by a `try?`).

This catches that class mechanically: it drives a real engine against a real
database, captures one payload per RPC, and decodes each with the exact type the
app uses.

```bash
tools/contract-check/run.sh                 # against your own RepoDeck database
tools/contract-check/run.sh <repodeck-home> # against a specific one
```

Exits non-zero on the first mismatch, and prints the field that did not line up.
