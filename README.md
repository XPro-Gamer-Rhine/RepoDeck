# RepoDeck

A native macOS app that keeps every repository you work on **current, understood, and running**.

Point it at a repo. It clones it, maps the codebase into an architecture graph
with a merge-churn heatmap, and writes a **knowledge graph** — the document a
Claude agent reads before it touches the code: what the repo does, which screen
calls which endpoint, what payload each endpoint expects, what comes back, what
changed last week. Then it watches. On a schedule, or within an hour of a pull
request merging, it fetches, updates, re-indexes what changed, refreshes the
knowledge graph, and restarts your local dev server on the new code.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/XPro-Gamer-Rhine/RepoDeck/main/install.sh | bash
```

Builds from source, installs to `/Applications`, and launches. Re-run to update.
Requires macOS 14+, Xcode Command Line Tools (`xcode-select --install`), and
Node.js 22.5+ (`brew install node`).

## What it does

**Connect GitHub.** Three ways in, in order of effort: borrow the token from a
`gh auth login` that already happened on this Mac, sign in on github.com with a
device code, or paste a personal access token. Tokens go in the **Keychain**;
RepoDeck's database stores only a reference to them.

**Add a repository.** Paste an SSH or HTTPS URL, or pick one from your account.
RepoDeck reads the remote first — which branches exist, which one the remote
calls HEAD — so the branch picker has real data in it before anything is
cloned. Leave the default branch on "follow the remote" and a team renaming
`master` to `main` won't leave RepoDeck watching a branch that stopped moving.

**The graph.** Two things are encoded at once:

- **Hue is what a file is.** Routes red, controllers blue, middleware purple,
  services cyan, engines orange, models yellow, pages pink, jobs green. Switch
  the hue source to folder, feature module, or connected cluster (Louvain
  communities over the real dependency graph).
- **Brightness and glow are how often it changes.** Same hue throughout: a
  stable route is a deep dark red, a route merged into every week is a bright
  glowing one. In the light theme it inverts — hot reads as deep and saturated
  against white.

Plus: size is connection count, so hubs read as hubs. Shape is a second,
colour-blind-safe encoding of layer. Every edge is **directed** — an arrowhead
on the target, curved so a mutual pair reads as two arcs rather than one line
drawn twice. Hovering a node blurs everything outside its neighbourhood and
names the relationships inside it. Dragging a node re-settles the simulation
around it. Solid edges are real imports; dashed ones are inferred, and every
inferred edge had to quote a line from the source that proves it — anything
unquotable is thrown away, because a wrong edge is worse than a missing one.

**What one dot means** is yours to pick: every file, folders, feature modules,
or **functions** — the last being the view that answers "where does `POST
/repos` actually go?". In the function view a node is a handler, function,
class or component, and an edge is a call, with the line it happens on.

**Four layouts**: `Force` (physics), **`Flow`** (columns left to right — screen →
route → middleware → controller → service → model, ordered within each column to
minimise crossings), `Circular` (everything on a ring, cross-cutting links as
chords) and `Grid` (hottest first).

**What landed.** Every merge gets a plain-language digest, written from its
commits *and its diff* rather than from the commit subjects: what changed, what
is new, what got fixed, what breaks, which two or three files are worth opening,
and a risk call with the reason for it. It appears on the dashboard and in the
merge history, so nobody has to read a diff to know whether last night's work
affects them.

**The knowledge graph.** Built during indexing, refreshed on every pull. Split
into what an agent needs to *understand* the code and what it needs to *change*
the code safely:

| Document | What it answers |
| --- | --- |
| Overview | What is this, what is it built from, how do I run it, what conventions apply |
| **Flows** | Where a request actually goes, hop by hop, every step a real call on a real line |
| **Playbooks** | Symptom → likely cause → which files to open in which order → what a correct fix looks like → how to verify it |
| API surface | Every endpoint, its handler, its middleware chain, the payload it expects, the shape it returns |
| **Functions** | Per function: purpose, return shape, what it changes outside itself, how it fails, what it assumes |
| **Errors** | Every failure the code can raise, the line that raises it, and what to check when you see it |
| Modules | Per feature: what it owns, which files to read first, where to extend, what not to break, its invariants |
| Data model | Entities, fields with types and requiredness, relations |
| Screens | Which page renders what and which endpoints it calls |
| **Tests** | Which test covers which file, and what each case asserts |
| Config | Every environment variable the code reads, and where |
| Changes | What changed since the last index, and what an agent that memorised the old version must unlearn |

Flows, errors and the test map are **derived, not asked**: they come out of the
call graph and the source, so every `path:line` in them is checkable. Only the
prose — purposes, meanings, playbooks — comes from a model, and it is written
against that derived material rather than against a summary of it.

**Export it.** One click writes a bundle:

```
CLAUDE.md              the agent-facing document — start here
AGENTS.md              same content, portable filename
flows.md               how a request moves, hop by hop
playbooks.md           symptom → where to look → how to fix → how to verify
api-surface.md         full request/response detail
functions.md           what each function promises and what it changes
errors.md              what a given error means and what to check
data-model.md
screens.md
tests.md
CHANGELOG.md
modules/<name>.md      one brief per feature module
agents/<name>.md       a drop-in Claude Code subagent per module, carrying that
                       module's flows, playbooks, function contracts and errors
knowledge-graph.json   the whole thing, machine-readable
call-graph.json        every function and every call between them, with lines
graph.json             file nodes and edges with heat
manifest.json          counts, the commit it describes, and a reading order
```

Drop it beside a repo and an agent starts knowing where it is. The per-module
files under `agents/` are the ones to point a Claude Code subagent at: each is a
complete brief for one feature area, with the paths and line numbers already in it.

**Pulling.** Every pull fetches first. The default treats the clone as a
mirror: `reset --hard origin/<branch>`, which cannot conflict because nothing
of yours is in it. The moment the tree *does* contain local commits or edits,
RepoDeck notices and upgrades to a real merge instead of throwing them away —
and a conflict there stops the pipeline rather than being papered over.

**Conflicts.** Optional, off by default. When on, RepoDeck reads the three
sides of every conflicted file and asks the model for a merge, showing you its
reasoning, its confidence, what it kept from each side, and a three-way diff.
Nothing is written until you approve it. Unattended runs apply a resolution
only when the model is confident about *every* conflicted file; anything less
waits for you with the proposal on record.

**Running it locally.** RepoDeck works out how the repo starts — `package.json`
scripts, Docker Compose, Procfile, Makefile, `manage.py`, `artisan`, `go.mod`,
`Cargo.toml` — and shows you the exact commands before running anything. Once
approved, a merge landing on the default branch restarts the process with the
new code, reinstalling dependencies only when a lock file actually moved.
Processes run in their own process group, so stopping takes the whole tree with
it instead of orphaning a bundler.

**Schedules.** Each repository carries its own: hourly, six-hourly, daily,
weekly, or never, in your timezone. Separately, a watcher polls GitHub — one
API call — for merged pull requests, hourly by default.

## Safety model

- **Credentials never touch the database or a command line.** They live in the
  macOS Keychain; the app pushes them to the engine over its stdin pipe, where
  they stay in memory for the session. A copy of the sqlite file is worthless.
- **A reset only ever runs on a tree RepoDeck itself filled.** Local work
  upgrades the pull to a merge automatically.
- **Nothing executes until you have seen the command.** Deploy profiles are
  proposed, printed, and only then approved.
- **Inferred graph edges must cite the source.** The model's quote is checked
  against the file on disk before the edge is kept.

## How it works

```
        ┌──────────────── RepoDeck.app ────────────────┐
        │  SwiftUI window  ·  menubar status           │
        │  native Canvas force-directed graph          │
        └───────────────┬──────────────────────────────┘
                        │  JSON-RPC / NDJSON over stdio
        ┌───────────────▼──────────────────────────────┐
        │  node engine · one process, many repos       │
        │  git · GitHub · scan+resolve · model passes  │
        │  Louvain · heat · knowledge graph · deploy   │
        │  per-repo cron + pull-request watchers       │
        └──────────────────────────────────────────────┘
```

- **`macos/`** — a SwiftUI app. The graph is drawn with `Canvas` over a force
  simulation that uses a uniform spatial grid for repulsion, so a 2,000-node
  repository stays interactive instead of paying for four million pairs a frame.
- **`engine/`** — a Node engine. The app starts one `node index.js daemon` at
  launch and keeps it for the session: it owns the cron tasks, the pull-request
  watchers, and the dev servers RepoDeck supervises, all of which have to
  outlive any one screen.

Storage goes through Node's built-in `node:sqlite`. That is deliberate — the
engine originally used a native module, which meant the app broke whenever the
machine's Node moved underneath it. There is now nothing to compile and nothing
to mismatch. `better-sqlite3` remains an optional fallback for older runtimes.

### Analysis pipeline

```
fetch → update → scan → resolve imports → build the call graph →
trace flows · catalogue errors · map tests → read merge history →
model mapping → feature consolidation → clustering → heat →
digest what landed → knowledge graph (contracts · errors · playbooks) → redeploy
```

A full run rebuilds everything. An incremental run re-maps only the files the
new merges touched, plus their graph neighbours so edges stay coherent — which
is what makes an hourly watcher affordable.

## Models

Any of:

| Kind | Notes |
| --- | --- |
| Claude (Anthropic) | Best results for the knowledge graph. |
| OpenAI | |
| OpenAI-compatible | Ollama, LM Studio, vLLM, OpenRouter, Azure — anything with a base URL. Local endpoints need no key. |

Each provider can name a cheaper **fast model** for the bulk passes (feature
grouping, module assignment) and keep the main model for the reasoning-heavy
ones. Repositories can each pick their own provider.

Without a provider, RepoDeck still builds the file graph, the real import
edges, the clusters and the heatmap — it just cannot write roles, feature
modules, or the knowledge graph, and it says so.

## Website

The landing page lives in `docs/` and is served by GitHub Pages.

## Build & run

```bash
cd engine && npm install && cd ..
cd macos && ./build-app.sh
open ../dist/RepoDeck.app
```

`build-app.sh` verifies the packaged engine answers `app.ping` before it
declares success, so a bundle that would fail at launch fails at build time.

The engine can be driven headlessly:

```bash
cd engine
node index.js daemon                      # JSON-RPC on stdin/stdout
node index.js index 1 --full              # re-index repo 1
```

## Where things live

| | |
| --- | --- |
| Clones | `~/Library/Application Support/RepoDeck/repos` |
| Database | `~/Library/Application Support/RepoDeck/data/repodeck.db` |
| Deploy logs | `~/Library/Application Support/RepoDeck/logs` |
| Exports | `~/Library/Application Support/RepoDeck/exports` |
| Secrets | macOS Keychain, service `com.repodeck.app` |

## Distribution, and why RepoDeck is not notarized

Notarization means uploading every build to Apple for approval. It needs a paid
Developer ID and a round trip on each release. RepoDeck is **ad-hoc signed**
instead, which macOS is perfectly happy to run — it just marks anything that
arrived over the network as quarantined and refuses to open it until that mark
is cleared.

So the mark gets cleared, explicitly, in the open:

- **The one-line installer** runs `xattr -dr com.apple.quarantine` on the
  installed app. That is the whole difference, and it is why the installer is
  the recommended path.
- **The DMG** ships a `Remove quarantine.command` you double-click once after
  dragging the app across, plus a README explaining why.
- **By hand:** `xattr -dr com.apple.quarantine /Applications/RepoDeck.app`

Build a DMG with `macos/make-dmg.sh`.

If you *do* have a Developer ID, `macos/notarize.sh` will sign, notarize and
staple the bundle properly — the script is there and works; it simply is not on
the default path.

One consequence of ad-hoc signing worth knowing: the signature changes on every
rebuild, so macOS asks once per build before RepoDeck can read its own Keychain
items.
