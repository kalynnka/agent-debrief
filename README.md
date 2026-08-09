# Agent Debrief

Snapshot-by-snapshot review of agent changes, in the editor where the language server
already runs.

The package is `agent-debrief`; everything you type is `debrief` — the command line,
the editor commands and the settings. Both names are deliberate: the long one is
unambiguous in a registry, and the short one is what you live with.

A snapshot is the unit of review — one per agent turn. Each captures the working tree
as a real git commit; the diff you read is **snapshot N-1 → snapshot N**, not
N-vs-base, so you never re-read work you already cleared. Comments batch by being
read all at once — the agent asks for them when you send it a message — and a
submit writes them out as one file.

## Why not per-edit approval

Approving every edit degrades to "approve all" the moment the agent is good enough to
be worth using — the same failure as auto mode, with more clicking. Reviewing a whole
turn's worth of work keeps a real decision point at a granularity worth reading.

## Your git state is not touched

Snapshots are built through a private index file (`GIT_INDEX_FILE`), so `git add -A`
never reads or writes the index you are curating. The commit object is written with
`commit-tree` and referenced under `refs/debrief/snapshots/<lane>/<n>` — outside
`refs/heads`, so `git branch` never lists it.

| | before snapshot | after |
|---|---|---|
| staged files | `M  b.py` | `M  b.py` |
| HEAD | `base` | `base` |
| branches | `main` | `main` |

Review state lives in `.git/debrief/`, so it never appears in `git status` and needs
no `.gitignore` entry.

## Several repositories at once

The unit of review is the repository, not the workspace folder. Folders are resolved to
their git roots and deduped, so a workspace holding four clones shows four repos, and a
`.vscode` directory added as its own folder folds back into the clone that contains it.
Each repo keeps its own snapshot numbering and its own `.git/debrief/`.

One **Take Snapshot** covers the whole workspace: every repo the work actually changed
gets a snapshot, and repos it did not touch get none, so a repo's numbering never
drifts from the work it describes.

## Use

1. **Snapshot once before the agent starts.** The first snapshot diffs against `HEAD`,
   so any changes already in your tree would otherwise show up inside snapshot 1.
2. Let the agent work.
3. **Debrief: Take Snapshot** (command palette, or the camera icon in the Snapshots
   view).
4. Click a file to open its snapshot-over-snapshot diff. For the newest snapshot the
   right-hand side is the real file on disk, so Pylance/pyright attaches — hover,
   types and go-to-definition all work while you read.
5. Comment on any line. Each one is open the moment you write it — there is no
   send step. Tell the agent you have reviewed and it reads them with
   `debrief review open`, fixes them, and answers each thread with
   `debrief review reply`. Its answer lands under your comment; click **✓** on the
   thread to close it when you are satisfied.
6. **Debrief: Submit Review** is for the record rather than for sending: it writes
   the open comments to `.git/debrief/<lane>/batches/<timestamp>.json` in the
   reviewed repo, which is the batch that leaves this machine.

Marking a file reviewed records the snapshot you reviewed it at. A later snapshot
touching that file makes it unreviewed again — the rule is just
`reviewed[file] >= snapshot`.

## Develop

```bash
pnpm install
pnpm run compile
pnpm test       # headless: git plumbing + store, no editor needed
```

`F5` launches an Extension Development Host opened on `../kraken`.

`src/core/` is the headless half — git plumbing, lanes, the store, review state — and
imports nothing from `vscode`; that is what lets the CLI and the tests run without an
editor. `src/ui/` is everything that draws. Both entry points stay at the `src/` root, so
`main` and `bin` remain `out/extension.js` and `out/cli.js`.

## Status

M1: lane-scoped core + CLI + extension client, TypeScript end to end — see
[docs/PRD.md](docs/PRD.md) and [docs/PLAN.md](docs/PLAN.md). Comments land as a
JSON batch in the reviewed repo's own `.git`; the intended home for sharing is
an Octomate review batch (M5). The web UI is meant to render the same batch
once its design settles.
