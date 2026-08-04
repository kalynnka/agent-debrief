# Octoview

Turn-by-turn review of agent changes, in the editor where the language server already runs.

A turn is the unit of review. Each snapshot captures the working tree as a real git
commit; the diff you read is **turn N-1 → turn N**, not turn-N-vs-base, so you never
re-read work you already cleared. Comments batch as drafts and submit as one file.

## Why not per-edit approval

Approving every edit degrades to "approve all" the moment the agent is good enough to
be worth using — the same failure as auto mode, with more clicking. Reviewing a whole
turn keeps a real decision point at a granularity worth reading.

## Your git state is not touched

Snapshots are built through a private index file (`GIT_INDEX_FILE`), so `git add -A`
never reads or writes the index you are curating. The commit object is written with
`commit-tree` and referenced under `refs/octoview/turns/<n>` — outside `refs/heads`,
so `git branch` never lists it.

| | before snapshot | after |
|---|---|---|
| staged files | `M  b.py` | `M  b.py` |
| HEAD | `base` | `base` |
| branches | `main` | `main` |

Review state lives in `.git/octoview/`, so it never appears in `git status` and needs
no `.gitignore` entry.

## Several repositories at once

The unit of review is the repository, not the workspace folder. Folders are resolved to
their git roots and deduped, so a workspace holding four clones shows four repos, and a
`.vscode` directory added as its own folder folds back into the clone that contains it.
Each repo keeps its own turn numbering and its own `.git/octoview/`.

One **Snapshot Turn** covers the whole workspace: every repo the turn actually changed
gets a turn, and repos it did not touch get none, so a repo's numbering never drifts
from the work it describes.

## Use

1. **Snapshot once before the agent starts.** The first turn diffs against `HEAD`, so
   any changes already in your tree would otherwise show up inside turn 1.
2. Let the agent work.
3. **Octoview: Snapshot Turn** (command palette, or the camera icon in the Turns view).
4. Click a file to open its turn-over-turn diff. For the newest turn the right-hand
   side is the real file on disk, so Pylance/pyright attaches — hover, types and
   go-to-definition all work while you read.
5. Comment on any line. Drafts accumulate.
6. **Octoview: Submit Review** writes the batch to
   `.git/octoview/<lane>/batches/<timestamp>.json` in the reviewed repo and
   marks the drafts submitted. Agents read it back with `octoview review batch`.

Marking a file reviewed records the turn you reviewed it at. A later turn touching that
file makes it unreviewed again — the rule is just `reviewed[file] >= turn`.

## Develop

```bash
pnpm install
pnpm run compile
pnpm test       # headless: git plumbing + store, no editor needed
```

`F5` launches an Extension Development Host opened on `../kraken`.

## Status

M1: lane-scoped core + CLI + extension client, TypeScript end to end — see
[docs/PRD.md](docs/PRD.md) and [docs/PLAN.md](docs/PLAN.md). Comments land as a
JSON batch in the reviewed repo's own `.git`; the intended home for sharing is
an Octomate review batch (M5). The web UI is meant to render the same batch
once its design settles.
