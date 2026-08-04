# Octoview — Executor Handoff

**Status:** M1 landed at `e80fae7` (2026-08-04, TypeScript end to end) · next:
hands-on verification, the §1 gate answer, then M2 planning

You are picking up after M1. [PRD.md](PRD.md) is what and why, [PLAN.md](PLAN.md)
is the order it landed in (with per-step **Landed** notes). This is everything
else you would otherwise have to rediscover.

**Read in this order:** PRD §1 (the problem) → PRD §4 (the review model) → PRD
§5 (architecture) → PLAN's per-step Landed notes → §7 below (what is actually
next). The PRD appendix is the list of things already verified by hand; trust it
and do not re-derive it.

---

## 1. The still-open decision gate

PLAN §2's question was never answered: does a locally-run Claude Code session
appear in VS Code's Agents Window with Changes and *Add Feedback*? The owner
consciously deferred it and had M1 built anyway; what survives a "yes" —
durability, the index invariant, PR review, cross-repo, plans — is what M1
mostly is. But the gate still decides how M2 is scoped. It is an owner-only,
hands-on check. Do not re-defer it silently into M2.

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

**TypeScript conventions** (owner decision 2026-08-04: no Python — one language
for core, CLI and extension): strict `tsc` is the gate — `pnpm run compile` and
`npx tsc -p ./ --noEmit` must be clean. No `any`, written or implicit; narrow
`unknown` at dynamic boundaries (see `src/transcript.ts` for the pattern). Git
executes only in `src/git.ts`; the UI modules (`extension`, `turns`, `comments`,
`diff`) are the only ones allowed to import `vscode`. Helpers need an owner and
real reuse. Prefer fail-fast errors over fallback control flow. Package manager
is pnpm with `nodeLinker: hoisted` (`pnpm-workspace.yaml`) — do not reintroduce
an npm lockfile or the symlinked layout.

---

## 3. Where things are

| Path | What it is |
|---|---|
| `~/Projects/octoverse/octoview` | This repo: core + CLI + extension (TypeScript) + these docs. History starts at `e80fae7` |
| `~/Projects/octoverse/kraken` | Clone of octomate at `3707d51`, venv synced. **The test subject.** Stop hook installed via `.claude/settings.local.json`, kept out of `git status` by `.git/info/exclude` |
| `~/Projects/octoverse/inky` | The octomate working repo. Do not experiment here — but it is hooked the same way, so real work there snapshots itself |
| `~/Projects/octoverse/nautilus` | An older octomate clone, unrelated |

Toolchain as verified: VS Code 1.131.0, Node v25.2.1, pnpm 10.32.1
(`packageManager` is pinned in package.json).

**Build and test:** `pnpm install`, `pnpm run compile`, `pnpm test`. Current
state is **109 assertions across 26 check groups, all passing**, entirely
headless — every module except the four UI ones avoids importing `vscode` so
the whole review core is testable from Node. Preserve that property.

**The Extension Development Host** launches with `F5`, opening `../kraken`
(`.vscode/launch.json`). Anything involving the tree view, comment widgets or
diff rendering can only be checked there, by a human.

---

## 4. Existing state you will encounter

`kraken` has two real turns from a live POC exercise, under the **old unscoped
ref scheme** the M1 code no longer reads:

```
refs/octoview/turns/1  843c628   tests reproducing a strip_markdown bug
refs/octoview/turns/2  2148454   the fix
```

Its working tree is **clean** — the owner reverted that change after reviewing
it. The turns survive anyway, which is the model working as intended: a turn
records what the tree was, not what it still is.

`inky` has one POC turn, `c269621`, with a phantom `D .python-version` from the
virgin-index bug — a before-and-after specimen. Both repos also carry POC-era
top-level files (`.git/octoview/{index,state.json}`) beside the new per-lane
dirs (`.git/octoview/<lane>/`). **All POC state is ignored, not migrated** —
the decision stands. Do not write migration code, and leave the specimens be.

Per-repo ownership is a stated principle now (PRD §4.3): everything octoview
records about a repo lives in that repo's own `.git`; the tool has no central
store.

---

## 5. Traps already paid for

Each of these cost real debugging. **All are fixed in M1 and pinned by
regression tests** (`test/smoke.js`, `test/cli.js`); the table stays because it
explains why the code looks the way it does.

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

`test/smoke.js` group 1 and `test/cli.js` group 9 assert exactly this — the
CLI-level check includes a staged file surviving snapshots byte-for-byte. Do
not weaken either.

---

## 7. What is actually next

M1's code is done; what remains is the part no test can do:

1. **The §1 gate answer** — owner, in the Agents Window, under an hour.
2. **A full editor-host review loop** — F5 opens `../kraken`; drive a turn,
   read the diff, batch comments, submit. M1 exit criterion 2.
3. **A live hook-driven turn appearing unprompted** — both inky and kraken are
   hooked; finish any real Claude turn there and watch the view. Criterion 5.
4. Then **M2 planning** (PRD §9): feedback round-trip via `--resume`, inline
   consult, plan artifacts, edit provenance — reordered by whatever M1's real
   use teaches. M2 gets its own plan document; do not grow this one.

---

## 8. Open decisions — do not invent answers

Both M1 decisions were ratified and built on 2026-08-04: the advisory lock file
(PRD §12, resolved) and the state-file watch (same). What is still open is
empirical — label quality from transcripts, snapshot cost at scale — and is
answered by using M1, not by deciding now.

If you hit a question these documents do not answer, ask. Do not resolve
ambiguity by picking the option that is easiest to build.
