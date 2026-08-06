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
| `git worktree remove` | The removed worktree's detached-lane state, if any, leaks. | Falls out of the same prune. |

### B. Commands that move history under the lane

| Command | Today | Should |
|---|---|---|
| `git commit` — **whole snapshot** | Recognised. | Unchanged. |
| `git commit` — **partial, from a staged subset** | Recognised since D1 landed — the commit takes every snapshot whose changes it completes. | Unchanged. |
| `git commit --amend` | Landing is recomputed from HEAD, so the answer just moves — correct by design. A snapshot's recorded `parent` may leave the branch, but the snapshot's own ref keeps it reachable. Verified: inky's snapshot 1 has parent `9966728`, no longer an ancestor of HEAD, still resolving. | Unchanged. |
| `git rebase`, `rebase -i`, squash, fixup | Same as amend. | Unchanged. |
| `git reset --soft`, `--mixed` | Index and HEAD move; the worktree does not, so snapshots still describe what is on disk. | Unchanged. |
| `git reset --hard` | The worktree goes back; every snapshot's files stop differing from where they started, so the rows go frozen and struck through. Honest, and the snapshot refs are what makes the work recoverable. | Unchanged, but see D5 — the frozen row offers **Drop**, which throws away the last record of the work at exactly the wrong moment. |
| `git revert <commit>` | A new commit; the worktree follows; affected snapshots go frozen. | Unchanged. |
| `git cherry-pick`, `git merge`, `git pull`, `git pull --rebase` | **Foreign content lands in the next agent snapshot.** A snapshot is `add -A` diffed against the previous snapshot, so anything that arrived in between is recorded as the agent's work. | Record HEAD per snapshot and subtract what the HEAD move brought in (D3). |
| History rewrites — `filter-repo`, `filter-branch` | Snapshot parents dangle; landing answers change. | Out of scope; document it. |

### C. Commands that move the working tree

| Command | Today | Should |
|---|---|---|
| `git restore <path>`, `git checkout -- <path>` | `GitWatch` fires, rows recompute, a file back at its starting content drops off its snapshot's worklist. Already designed for. | Unchanged. |
| `git stash`, `git stash pop`/`apply` | A stash makes every snapshot look reverted — frozen, struck through, droppable — and a pop puts them all back. | Unchanged in what it shows; D5 covers the destructive action offered while it is true. |
| `git clean -fd` | Deletes untracked files a snapshot created; those snapshots go frozen. | Unchanged. |
| `git apply`, `git am` | Ordinary worktree writes; captured by the next snapshot as the agent's work. | Same problem as merge/pull (D3), same fix. |
| Conflict resolution during merge/rebase | Conflict markers on disk are captured verbatim by a snapshot taken mid-conflict. | Skip snapshotting while `MERGE_HEAD`/`REBASE_HEAD` exists. |

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

**D2 — Lanes do not follow branches.** *(half fixed)*
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

**D3 — Foreign changes are attributed to the agent.**
`git pull` between two snapshots puts everyone else's work in the agent's next
snapshot, under its name and its message. Fix in two steps: record HEAD on the
`Snapshot` record, then subtract — when HEAD moved from H0 to H1 under a
snapshot, the paths in `diff(H0,H1)` that hold H1's content are the checkout's
doing, not the agent's. Step one alone is worth having: a header line saying HEAD
moved under this snapshot tells the reviewer what they are looking at.

**D4 — Detached HEAD has no lane of its own.** *(fixed)*
`resolveLane` fell back to the worktree directory name, so every detached state
in a clone shared one lane, a bisect run appended to it a snapshot at a time, and
a clone whose directory happened to share a name with a branch appended to that
branch's lane. It is `detached/<sha7>` now.

**D5 — Destructive actions stay offered while git is mid-operation.**
A stash, a hard reset or a revert makes snapshots look frozen, and a frozen
snapshot's row offers **Drop** — which deletes the ref, and with it the only
remaining copy of the work. Gate the action on the worktree not being in a state
that explains the freeze.

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

*Not done here:* the sweep runs only when asked. Wiring it into the extension —
either automatically on refresh or as an abandoned-lane row with a button — is
still open, and so is the leftover `refs/octoview/turns/1` in inky and kraken,
which belongs to the pre-lane POC scheme nothing reads.

**Phase 3 — Attribute honestly (fixes D3, D5).**
`head` on the `Snapshot` record (schema 2 → 3), a header line when it moved,
subtraction of what the move brought in, and no snapshot while a merge or rebase
is in progress. Gate Drop on the worktree state.
*Done when:* a snapshot taken after a `git pull` shows the pulled files as the
merge's rather than the agent's, and a stash does not offer to drop anything.

**Phase 4 — Write it down.**
PRD §4.2 and §4.8 reconciled with what was built, this catalogue kept as the
contract, WORKFLOWS and the two skills updated where the reviewer's own git
commands now mean something different.

Phase 1 is the reported bug and stands alone. Phases 2 and 3 are each a sitting's
worth of review on their own, so they should not be folded together.

## 5. Deliberately not followed

- **Pushing snapshots.** They stay in the clone that made them. A review is a
  local artefact and a shared `refs/octoview/**` would be a synchronisation
  problem with no owner.
- **History rewrites.** `filter-repo` and friends invalidate every recorded sha.
  We detect nothing and claim nothing.
- **Anything that writes the reviewer's index or HEAD.** The private index file
  is the whole reason snapshotting is invisible, and the only destructive git
  command octoview may run is deleting a ref it created itself.
