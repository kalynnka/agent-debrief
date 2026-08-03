# Octoview — Executor Handoff

**Status:** ready for M1 · **Last updated:** 2026-08-04

You are picking up implementation. [PRD.md](PRD.md) is what and why,
[PLAN.md](PLAN.md) is the order. This is everything else you would otherwise
have to rediscover.

**Read in this order:** PRD §1 (the problem) → PRD §4 (the review model) → PRD
§5 (architecture) → PLAN §2 (the decision gate) → PLAN §3 (your first code step).
The PRD appendix is the list of things already verified by hand; trust it and do
not re-derive it.

---

## 1. Do not start with code

PLAN §2 is a decision gate, and it is not optional. If a locally-run Claude Code
session already appears in VS Code's Agents Window with Changes and *Add
Feedback*, M1 and M2 need rewriting before anything is built. **Report the answer
and stop.** Do not proceed to Step 1 on your own judgement.

---

## 2. Working agreements that will bite you

These come from the repo owner's `AGENTS.md` and are not negotiable.

- **The git index is theirs.** Never run `git add`, `git commit -a`, or anything
  that stages. Leave changes unstaged and say what you touched. This is also the
  product's core invariant, so violating it in the tooling is doubly wrong.
- **Committing, pushing and opening a PR each need approval in the owner's most
  recent message.** Approval does not carry over from an earlier turn. Finish the
  work, run the checks, report, stop.
- **One concern per change.** No drive-by cleanups, renames or reformatting mixed
  into behavioural changes.
- **If a change outgrows one sitting's reading, stop and offer the split** rather
  than delivering it whole. PLAN names the likely split points in Steps 2 and 4.
- **Report verification with real numbers** — `30 assertions, 9 groups`, not
  "tests pass". State plainly what you did not check. A pre-existing failure is
  the headline, never background noise.

**Python conventions** (the CLI is Python): `ruff format` and `ruff check` must
pass on touched files, passed explicitly by path — never format the whole tree.
Pyright clean at `basic`. No `typing.Any` or `object`. No `cast` or
`type: ignore` to silence a true positive. Helpers need an owner and real reuse;
no single-call `_private` helpers. Prefer fail-fast errors over fallback control
flow.

---

## 3. Where things are

| Path | What it is |
|---|---|
| `~/Projects/octoverse/octoview` | This repo. TypeScript POC extension + these docs |
| `~/Projects/octoverse/kraken` | Clone of octomate at `3707d51`, venv synced. **The test subject** |
| `~/Projects/octoverse/inky` | The octomate working repo. Do not experiment here |
| `~/Projects/octoverse/nautilus` | An older octomate clone, unrelated |

Toolchain as verified: VS Code 1.131.0, Node v25.2.1, uv 0.8.13, Python 3.13.7.

**`octoview` has no commits at all** — `main` is unborn, every file untracked.
Consequence you will hit immediately: the POC cannot snapshot its own repo,
because `commit-tree -p` needs a parent. That is one of the two bugs Step 2 fixes.

**Build and test the extension:** `npx tsc -p ./` then `npm test`. Current state
is **30 assertions across 9 check groups, all passing**, entirely headless —
`git.ts`, `state.ts` and `repos.ts` deliberately avoid importing `vscode` so they
can be tested from Node. Preserve that property in whatever replaces them.

**The Extension Development Host** launches with `F5`, opening `../kraken`
(`.vscode/launch.json`). Anything involving the tree view, comment widgets or
diff rendering can only be checked there, by a human.

---

## 4. Existing state you will encounter

`kraken` has two real turns from a live exercise:

```
refs/octoview/turns/1  843c628   tests reproducing a strip_markdown bug
refs/octoview/turns/2  2148454   the fix
```

Its working tree is **clean** — the owner reverted that change after reviewing
it. The turns survive anyway, which is the model working as intended: a turn
records what the tree was, not what it still is.

`inky` has one turn, `c269621`, taken with the pre-fix build. It carries a
phantom `D .python-version` from the virgin-index bug. Leave it alone; it is a
before-and-after specimen, not something to migrate.

**PLAN §7 decides that all POC state is discarded rather than migrated** when the
extension becomes a client. Do not write migration code.

---

## 5. Traps already paid for

Each of these cost real debugging. They are in the PRD appendix; this is the
executable summary.

| Trap | What happens | What to do |
|---|---|---|
| Virgin private index | `git add -A` skips a file that is tracked *and* gitignored, so every turn reports it deleted. `kraken` pins `.python-version` this way | `git read-tree <parent>` into the private index before `add -A` |
| `.git` is a **file** in a linked worktree | `mkdir .git/octoview` fails `ENOTDIR`; snapshot and store both die | Resolve paths through `git rev-parse --git-common-dir` |
| Refs are shared across a clone's worktrees | `refs/octoview/turns/<n>` collides between worktrees | Lane-scope every ref: `refs/octoview/turns/<lane>/<n>` |
| `--name-status -z` rename records | Three fields, not two. Pair-wise parsing silently drops the new path | Parse `R`/`C` statuses as three fields, or pass `--no-renames` |
| Unborn HEAD | `commit-tree -p` fails in a fresh `git init` repo | Turn 1 commits with no parent; diff against the empty-tree hash |
| Refs may point at blobs | Not a trap — a capability. `update-ref` accepts a blob and `git diff <blobA> <blobB>` works | This is how plan artifacts avoid touching the tree (§4.7) |

---

## 6. Verifying the invariant

Every step that touches git must keep this true, and it must be a test, not a
claim:

```
before N snapshots        after N snapshots
  git status --porcelain    unchanged
  git rev-parse HEAD        unchanged
  git branch --list         unchanged
```

`test/smoke.js` already asserts exactly this against a temp repo with a staged
file. Port it; do not weaken it.

---

## 7. First deliverable

PLAN §3, Step 1: the CLI package, the JSON envelope, `--repo` / `--lane`
resolution, and `octoview status` returning a valid empty result.

Done when: the envelope shape is tested; lane resolution is tested in a main
tree, a linked worktree and on a detached HEAD; `ruff format` and `ruff check`
pass on the new files; and `octoview status --json` runs against `kraken` and
prints its two existing turns' lane correctly.

Then stop and report. Do not continue into Step 2 without review.

---

## 8. Open decisions — do not invent answers

PRD §12 lists five. Two land inside M1 and have recommendations in PLAN, but the
owner has not ratified them:

1. **Concurrent writers** (§12.1) — PLAN §5 recommends an advisory lock file
   around every read-modify-write. Confirm before implementing.
2. **How the UI learns a turn happened** (§12.2) — PLAN §8 recommends a file
   watch on `state.json`. Confirm before implementing.

The other three are empirical and answered by using M1, not by deciding now.

If you hit a question these documents do not answer, ask. Do not resolve
ambiguity by picking the option that is easiest to build.
