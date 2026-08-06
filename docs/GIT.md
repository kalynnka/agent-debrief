# Octoview — Git Operations

Octoview is attached to git, not in front of it. Every fact it shows is derived
from refs, trees and blobs, and every one of them can be moved by a git command
run in a terminal with no idea octoview exists. That is the normal case, not the
edge case: the reviewer stages what they have read and commits it by hand, cuts a
branch mid-review, pulls, stashes, amends.

So the rule this document exists to hold: **a git command the reviewer runs is
never wrong.** If octoview's view disagrees with git afterwards, octoview is
what has to change. We never ask the reviewer to work through us to keep our
bookkeeping true, and we never record anything we could derive instead.

## 1. The three keys, and how each one goes stale

Everything octoview stores hangs off one of three keys. Every defect in §3 is one
of them going stale.

| Key | Where it is used | What moves it |
|---|---|---|
| **Lane name** — the checked-out branch | `refs/octoview/snapshots/<lane>/<n>`, `<common-dir>/octoview/<lane>/` | `switch`, `checkout -b`, `branch -m`, `branch -d`, detaching HEAD, `worktree` |
| **Content identity** — trees and blobs | Which snapshot a commit landed, whether a file is still the snapshot's doing, whether a thread's anchor still exists | Anything that writes the worktree or makes a commit |
| **HEAD** | The base of snapshot 1, "landed", the file rows' `committed` marks | `commit`, `amend`, `rebase`, `reset`, `revert`, `merge`, `pull`, `switch` |

Nothing is recorded that git can answer. Landing is derived, not stored, so an
amend simply changes the answer — that part already works and should stay that
way.

## 2. The catalogue

Every git command that can reach one of those keys, what octoview does about it
today, and what it should do. "Today" is what the code does as of this document,
verified against the working repos rather than read off the PRD.

### A. Commands that move the checkout — a different lane

| Command | Today | Should |
|---|---|---|
| `git switch <branch>`, `git checkout <branch>`, `gh pr checkout` | Works. `GitWatch` reports the branch change, repos re-resolve, the new lane's state loads (or an empty one). | Unchanged. |
| `git switch -c <new>`, `git checkout -b <new>` | The new lane inherits the one it was cut from — state copied, refs re-pointed at the same commits — while the branch still stands where it was created. | Unchanged. |
| `git branch -m <old> <new>` | The lane moves with the branch; nothing is left under the old name. | Unchanged. |
| `git branch -d`, `git branch -D` | `octoview gc` lets go of the lane's refs, so git can collect the snapshots on its own schedule; a lane git has already collected is forgotten. | Unchanged. |
| `git checkout <sha>`, `git switch --detach`, `git bisect` | A lane of its own, `detached/<sha7>`. | Unchanged. |
| `git worktree add` | Works. The common dir is shared, so lanes are shared and branch-per-worktree keeps them apart. | Unchanged. |
| `git worktree remove` | Its `detached/<sha>` lane has no branch, so `octoview gc` sweeps it like any other. | Unchanged. |

### B. Commands that move history under the lane

| Command | Today | Should |
|---|---|---|
| `git commit` — **whole snapshot** | Recognised. | Unchanged. |
| `git commit` — **partial, from a staged subset** | Recognised since D1 landed — the commit takes every snapshot whose changes it completes. | Unchanged. |
| `git commit --amend` | Landing is recomputed from HEAD, so the answer just moves — correct by design. A snapshot's recorded `parent` may leave the branch, but the snapshot's own ref keeps it reachable. Verified: inky's snapshot 1 has parent `9966728`, no longer an ancestor of HEAD, still resolving. | Unchanged. |
| `git rebase`, `rebase -i`, squash, fixup | Same as amend. | Unchanged. |
| `git reset --soft`, `--mixed` | Index and HEAD move; the worktree does not, so snapshots still describe what is on disk. | Unchanged. |
| `git reset --hard` | The worktree goes back; every snapshot's files stop differing from where they started, so the rows go frozen and struck through. Honest, and the snapshot refs are what makes the work recoverable. | Unchanged. Drop is now refused while git is mid-operation (D5); a plain `reset --hard` is not an operation git considers itself inside, so that case still relies on the frozen row reading as a fact rather than an instruction. |
| `git revert <commit>` | A new commit; the worktree follows; affected snapshots go frozen. | Unchanged. |
| `git cherry-pick`, `git merge`, `git pull`, `git pull --rebase` | HEAD is on the snapshot record; the note names the move and the rows it brought are marked `⇣`. | Unchanged. |
| History rewrites — `filter-repo`, `filter-branch` | Snapshot parents dangle; landing answers change. | Out of scope; document it. |

### C. Commands that move the working tree

| Command | Today | Should |
|---|---|---|
| `git restore <path>`, `git checkout -- <path>` | `GitWatch` fires, rows recompute, a file back at its starting content drops off its snapshot's worklist. Already designed for. | Unchanged. |
| `git stash`, `git stash pop`/`apply` | A stash makes every snapshot look reverted, and `operationInProgress` cannot see it — a stash is a completed act, not something git is inside. So the snapshot records `refs/stash` instead: when it has moved, the frozen row says *stashed* rather than *reverted*, and Drop is refused. | Unchanged. |
| `git clean -fd` | Deletes untracked files a snapshot created; those snapshots go frozen. | Unchanged. |
| `git am` | Commits, so HEAD moves and D3's rule marks what it brought. | Unchanged. |
| `git apply` | It patches the worktree without moving HEAD, so there is no move to read. Answered by a **turn-start snapshot** instead: a hook takes one before the agent runs, so the human's edits land in their own snapshot and the agent's diff starts after them. | Unchanged. |
| Conflict resolution during merge/rebase | Refused. `operationInProgress` reads git's own marker files, and a snapshot is not taken while one exists. | Unchanged. |

### D. Commands that move the index only

| Command | Today | Should |
|---|---|---|
| `git add`, `git restore --staged`, `git reset <path>`, `git rm --cached` | Works. `GitWatch.stagedPaths` marks the file row `staged`. Octoview's own snapshotting uses a private `GIT_INDEX_FILE` and never touches this index. | Unchanged. This is the one part of the contract that is already exactly right. |

### E. Object lifetime and transport

| Command | Today | Should |
|---|---|---|
| `git gc`, `git prune`, `git reflog expire` | Our refs are GC roots, so a live lane's snapshots are pinned — correctly. `octoview gc` lets go of dead lanes, and from there git's own retention applies: `gc.pruneExpire` for the objects, `gc.reflogExpireUnreachable` for what a reflog still names. | Unchanged. Octoview never runs `git gc` for you. |
| `git push`, `git fetch` | `refs/octoview/**` is outside the default refspecs, so snapshots stay local. Correct and worth keeping. | Unchanged; document that `push --mirror` would send them. |
| `git clone` | A clone carries no review history. Intended — PRD §4.3. | Unchanged. |

### F. Reaches nothing

`git tag`, `git notes`, `git config`, `git log`, `git blame`, `git submodule`,
`git lfs`. Listed so the catalogue is a closed set rather than an open one.

## 3. What the catalogue exposes

Five defects, worst first.

**D1 — Landing was whole-tree, so hand-made commits never landed.** *(fixed)*
`landedCommits` recognised a commit only when its tree *was* a snapshot's tree —
true by construction for commits octoview makes and for nothing else. Measured on
inky's lane before the fix: two snapshots, HEAD `165b9ec`, `landedCommits` and
`landedSnapshots` both empty, while all three of snapshot 2's files were already
byte-identical to HEAD. Every file row said `committed` under a snapshot octoview
called uncommitted, and the Commits group was hidden because it held nothing.

*The rule now.* A snapshot has landed at a revision when, for every path it
changed, that revision holds the blob the snapshot left there — **or** the blob a
later snapshot left, since a change written over by later work still reached the
branch through the work that replaced it. Without the "or later", a lane of fifty
snapshots could only ever land in its final commit.

It survives the case that killed the last per-file attempt (once "marked 28 of 36
snapshots committed in a repo that had never been committed to"). That rule
quantified over the files a snapshot still *owns*, which is empty when a later
snapshot rewrote all of them, making the claim vacuously true. This one quantifies
over every path the snapshot changed, which is never empty — a snapshot with no
changed files is never created.

*What it cost.* The prefix model. A commit can land snapshot 2 while snapshot 1 is
still half outstanding, so the Committed area no longer assumes a run and a
commit's row reads `snapshots 2, 5–7` where that is the truth. `committableRun` is
untouched: it governs what *we* may commit, which is a different question.

*Attribution.* The earliest commit at which the condition first holds, walking
from where the lane started. No fast path was needed — the content rule reproduces
octoview's own history exactly (5–13, 14–47, 48–50).

**D2 — Lanes do not follow branches.** *(fixed)*
Cutting a branch abandoned the review; deleting one still leaks it. PRD §4.2
already specified that a lane closes when its branch is deleted or merged, and
§4.8 specified the prune — neither existed in the code.

*Cut and rename, done.* A branch's own reflog says where its name came from:
`branch: Created from HEAD` as its only entry means it has not moved since it was
cut, and `Branch: renamed refs/heads/<old> to …` means it was renamed. The first
copies the source lane (`@{-1}` names it), the second moves it. Both refuse once
the branch has a commit of its own — from then on it is a line of work of its
own, and inheriting someone else's snapshots would be a claim about code they
never saw. `adoptLane` runs from every entry point, extension and CLI alike, so
whichever one the reviewer or the hook reaches first is the one that heals it.

*Delete, done — and the owner's answer was better than the recommendation that
stood here.* I had proposed octoview decide, with a "nothing unreviewed, no open
thread" guard. The right answer is that octoview decides nothing: **follow git.**

A snapshot ref is a GC root, so while octoview holds one, `git gc --prune=now`
cannot touch that snapshot — verified. That is the actual leak: a lane left by
`git branch -d` pins its objects forever. So `octoview gc` lets go of the refs and
stops. From that moment the snapshot is an ordinary unreachable object on git's
own schedule, and the reviewer's real cleanup takes branch and snapshots together.
A lane whose objects git has since collected is forgotten, because there is
nothing left to review — git made that call, octoview only noticed.

The asymmetry to know: a deleted branch's commits stay named in HEAD's reflog for
`gc.reflogExpireUnreachable`, but a snapshot commit is in **no reflog at all** —
`core.logAllRefUpdates` does not cover `refs/octoview/`, and it was never on a
branch. `state.json` stands in, holding every sha, so a lane can be put back with
`git update-ref` while the objects last. The window is `gc.pruneExpire`: git's
knob, not one octoview invents.

**D3 — Foreign changes are attributed to the agent.** *(fixed)*
`git pull` between two snapshots puts everyone else's work in the agent's next
snapshot, under its name and its message.

*Done.* `Snapshot.head` records HEAD at capture (schema 3), and `Notes.md` opens
with a line naming the move — `HEAD moved under this snapshot: a1b2c3d → e4f5g6h`
— so a reviewer knows before reading the diff that some of it is not the agent's.
And a worktree part-way through a merge, rebase, cherry-pick, revert or bisect is
refused rather than captured: conflict markers and half-applied commits are
nobody's work yet, so `takeSnapshot` returns `mid-operation` instead of recording
them.

*Done: the subtraction.* `foreignPaths` marks the paths a HEAD move brought in,
and they carry `⇣` on the review row and the tree row.

*And `git apply`, which moves no HEAD.* There is no signal in git for it — by the
time a snapshot is taken, a hand-applied patch and a hand-typed edit are the same
bytes with the same provenance. So the answer is not detection but **a second
snapshot**: take one *before* the agent's turn starts, attributed to the human,
and everything they did lands in their own snapshot rather than the agent's next
one. The agent's diff then begins where the human's edits ended.

This needed no code — `--agent manual` already exists — only a hook beside the
Stop one:

```json
"UserPromptSubmit": [{ "hooks": [{ "type": "command",
  "command": "node <octoview>/out/cli.js snapshot --agent manual --label 'before the turn'" }]}]
```

Verified end to end: patch `f.txt` by hand with `git apply`, prompt, and snapshot
1 is `M f.txt [manual]` while snapshot 2 is `A agent.txt [claude]`. Snapshotting is
idempotent, so a turn where the human changed nothing costs nothing. What it does
*not* cover is an edit made while the agent is mid-turn — that still lands in the
agent's snapshot, and no arrangement of hooks can separate it.

**D4 — Detached HEAD has no lane of its own.** *(fixed)*
`resolveLane` fell back to the worktree directory name, so every detached state
in a clone shared one lane, a bisect run appended to it a snapshot at a time, and
a clone whose directory happened to share a name with a branch appended to that
branch's lane. It is `detached/<sha7>` now.

**D5 — Destructive actions stay offered while git is mid-operation.** *(fixed)*
A merge or rebase in progress makes snapshots look frozen, and a frozen row
offered **Drop** — which deletes the ref, and with it the only remaining copy of
work that is perfectly alive. Revert and Drop now refuse while
`operationInProgress` answers, and say which operation to finish first.

*And `git stash`, which git does not consider itself inside.* Verified —
`operationInProgress` returns undefined after a stash, so that gate cannot catch
it. A stash leaves the worktree exactly where a reviewer undoing the snapshot
would: octoview cannot tell them apart by looking.

So the snapshot records `refs/stash` alongside HEAD (schema 4), and `stashedSince`
asks the one question it can answer: has the stash moved? When it has, the frozen
row's hover says **stashed, not reverted**, and Drop is refused with the same
reason. It is narrow — reverting a file that is still live is untouched — and it
errs toward silence: a snapshot from before the field existed says nothing rather
than guessing, because a false alarm on every old lane teaches people to ignore
the real one.

**This is the one heuristic in the codebase**, and it is deliberate: everything
else here is derived from git. The alternative was leaving a button that deletes
the last record of work sitting safely in a stash.

## 4. Plan

Four phases, each landable and reviewable on its own, in the order the review
reads: rule first, then lifecycle, then attribution, then the docs.

**Phase 1 — Land on content (fixes D1).** ✅ **Done.**
`landedCommits` decides by content and `landedSnapshots` is derived from it, so
the two cannot drift; the commit row renders a range list rather than a span. No
schema change — landing stays derived.
*Verified:* inky's lane now shows snapshot 2 under `165b9ec` and snapshot 1, which
is half committed, correctly does not land. octoview's own history still groups as
5–13, 14–47, 48–50, plus one group per commit since. 40 checks pass (19 smoke +
21 cli), including a new one that stages half a snapshot, commits it, and asserts
nothing lands until the rest goes in.

**Phase 2a — Lanes follow branches (fixes D2's first half, and D4).** ✅ **Done.**
`laneOrigin` reads the branch's reflog, `adoptLane` copies on a cut and moves on a
rename, and a detached HEAD is `detached/<sha7>`. Both entry points call it.
*Verified:* 41 checks pass (20 smoke + 21 cli). The new smoke check cuts a branch
mid-review and asserts the snapshots, the reviewed marks and the refs all arrive;
commits on the new branch and asserts a second cut inherits nothing; renames and
asserts the old directory and refs are gone; and detaches to assert the lane is
named by the commit.

**Phase 2b — Lanes end with their branches (D2's second half).** ✅ **Done.**
`sweepLanes` and `octoview gc [--dry-run]`. No age window, no cap, no staleness
octoview judges for itself — a lane is closed because its branch is, and forgotten
because git already collected it.
*Verified:* 42 checks pass (21 smoke + 21 cli). The new smoke check proves the
whole chain end to end: a live lane is never swept; after `branch -D`, `gc
--prune=now` **cannot** collect the snapshot because our ref pins it; a dry run
reports and changes nothing; applying drops the ref but deletes nothing, leaving
`state.json` holding the sha; the next `gc --prune=now` collects; and only then is
the lane forgotten. On inky, `octoview gc --dry-run` finds the one orphaned lane.

**Phase 2c — the button.** ✅ **Done.** A repo row with abandoned lanes goes
warning-coloured with a count badge (`list.warningForeground`, via the decoration
provider — a `TreeItem` carries no colour of its own) and grows a bin. Pressing it
opens a modal listing the lanes and saying plainly which part cannot be undone:
octoview deletes no commits, but a snapshot commit is in no reflog, so once git
collects them nothing will name them again. The sweep re-runs on press rather than
trusting the row, since a branch can appear or vanish in a terminal in between.

**Phase 2d — stray refs.** ✅ **Done.** The sweep also reports refs under
`refs/octoview/` that no lane claims — the pre-lane POC scheme's unscoped
`refs/octoview/turns/<n>`, and anything a half-finished operation left behind.
Nothing can read them and they pin their objects exactly as a live snapshot's ref
does. Live dry runs find one in inky and two in kraken.

This reverses HANDOFF §4's "leave the specimens be": those refs were kept as a
before-and-after specimen of the virgin-index bug, which is now pinned by a
regression test instead. `octoview gc` does not delete their objects either — the
same hand-to-git rule applies.

**Phase 3a — Attribute honestly (fixes D5, half of D3).** ✅ **Done.**
`Snapshot.head` (schema 3), the note's HEAD-moved line, `mid-operation` as a named
refusal rather than a silent no-op, and Revert/Drop gated on it.
*Verified:* 43 checks pass (22 smoke + 21 cli). The new smoke check records HEAD,
lands a real merge under a snapshot and asserts the recorded HEAD moved, then
drives an actually-conflicting merge and asserts the snapshot is refused with
`mid-operation` — not with `unchanged`, which would have hidden it.

**Phase 3b — The subtraction (D3's other half).** ✅ **Done.**
`foreignPaths` marks the paths a HEAD move brought in, and they say so where a
reviewer reads: `⇣` on the multi-diff row, `⇣ not the agent's` on the tree row,
and a hover saying why. The rule is deliberately one-sided — a path counts as the
move's only while the snapshot still holds it exactly as the move left it, so an
agent edit on top of a merged file stays the agent's. False negatives are safe;
false positives hide a real edit.
*Found on the way:* the row marks live in the resource URI's file name, and
nothing stripped them off again — so the row toolbar's tick could mark a file but
never unmark it, because the second press tried to resolve `src/✓ files.ts`. That
was already broken for ticked rows before `⇣` existed.
*Verified:* 44 checks pass (23 smoke + 21 cli). The new check merges a branch
under a snapshot and asserts the merged file is not the agent's while the agent's
own file is, that nothing is foreign when HEAD did not move, and that a file the
agent edits after the merge goes back to being theirs.

**Phase 4 — Write it down.** ✅ **Done.** PRD §4.2 and §4.8 reconciled as each
phase landed; this catalogue is the contract; WORKFLOWS and HANDOFF follow.

**Phase 5 — the two residues.** ✅ **Done.** `git stash` answered by recording
`refs/stash` (schema 4); `git apply` answered by the turn-start hook. Every row of
the catalogue now reads "Unchanged", bar the two entries §5 says are deliberately
not followed.
*Verified:* 45 checks pass (24 smoke + 21 cli). The stash check proves a stash puts
the file back exactly as a revert would, that the moved tip is what distinguishes
them, that popping clears it, and that an unrecorded tip reads as unknown rather
than as zero.

## 5. Deliberately not followed

- **Pushing snapshots.** They stay in the clone that made them. A review is a
  local artefact and a shared `refs/octoview/**` would be a synchronisation
  problem with no owner.
- **History rewrites.** `filter-repo` and friends invalidate every recorded sha.
  We detect nothing and claim nothing.
- **Anything that writes the reviewer's index or HEAD.** The private index file
  is the whole reason snapshotting is invisible, and the only destructive git
  command octoview may run is deleting a ref it created itself.
