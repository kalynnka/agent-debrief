# Working with an agent through Octoview

The situations this tool is for, and what each side does in them.
[PRD §3](PRD.md) states the use cases as requirements; this is the practical
companion — what you click, what the agent runs, and what Octoview does in
between. Everything here works against the current build unless it is marked
**not built yet**.

The unit is the **snapshot**: one agent turn's work, captured as a real git commit
under `refs/octoview/snapshots/<lane>/<n>` and diffed against the snapshot before
it. Your index, your HEAD and your branches are never touched.

---

## 1. The everyday loop

### 1.1 The agent finishes; you review

The Stop hook snapshots the working tree the moment the agent stops:

```bash
octoview snapshot --from-stop-hook   # reads the hook payload on stdin
```

It takes the repo, the session id and a label from the transcript, so the snapshot
arrives already named. The Snapshots view notices — a file watch on the lane's
state directory, not a service — and the new snapshot appears at the bottom, expanded.

You open a file, read **snapshot N-1 → snapshot N**, and mark what you have cleared.
The agent is free to keep working the whole time; nothing you do blocks it.

### 1.2 You stepped away and it took six snapshots

Read the delta, not the branch. A file you cleared at snapshot 2 that nobody has
touched since stays cleared; a file snapshot 5 touched is open again. The whole rule
is `reviewed[file] >= snapshot`, so nothing has to be recomputed or invalidated.

Select snapshots 3–6 and press **Open Net Diff of Selected Snapshots** to read them
as one change, or walk them one at a time. A non-contiguous selection works too —
ctrl-click snapshots 3 and 6 — and the diff shows only what those two did, not the
snapshots in the gap.

### 1.3 You want to stop mid-turn

Interrupt the agent and run **Octoview: Take Snapshot** yourself. A manual
snapshot is a first-class entry point, not a fallback: it records whatever exists
right now as its own snapshot, and the agent's next snapshot diffs against it.

If nothing has changed since the last one, nothing is taken — snapshotting is
idempotent, so an idle interrupt cannot pollute the numbering.

And nothing is taken while git is part-way through a merge, rebase, cherry-pick,
revert or bisect. Conflict markers and half-applied commits are not the agent's
work and not yours yet, so a snapshot then would be a record nobody could read.
Finish or abort the operation and the next snapshot picks it all up. Revert and
Drop refuse for the same reason — mid-merge, the rows describe git's work.

---

## 2. Reading a change

| you want | do this |
|---|---|
| one file, one snapshot | click the file row under the snapshot |
| everything one snapshot did | click the snapshot row |
| several snapshots as one change | select them, then **Open Net Diff of Selected Snapshots** |
| everything you have approved | click the **Reviewed** area row |
| one file's evolution across snapshots | **Open Step History** on the file row |
| the whole lane | click the repo row |

The first row of a multi-file review is `Notes.md`: what the agent said when it
finished each of the snapshots you selected, in full. The tab title says only
which snapshots and how big, and the tree row has room for the first line — this
is the whole of it, and it is meant to be read before the diff. It is a diff row
like any other, so it shows the message as text. The `prepare-change-review`
skill is what tells an agent to close a turn with a message worth putting there:
kind, goal, how, test numbers, what to look at — in plain text, because nothing
renders that row.

Hovering a snapshot's row in the sidebar shows its state and the message's
opening paragraph, rendered. A hover clips rather than scrolls, so the rest is a
click away: **Read the whole note** opens the message as its own document, which
scrolls and copies like any other. (VS Code's own `⌘K ⌘I` focuses a hover and
makes it scrollable, if you would rather stay there.)

For the **newest** snapshot the right-hand side of a diff is the real file on disk,
so the language server attaches — hover, types and go-to-definition all work while
you read. Older snapshots diff two revisions and are read-only by nature.

That has an edge, and Octoview handles it rather than leaving it to you. A review
of snapshot 10, opened while 10 was newest, points at the file; when snapshot 11
lands, the file holds 11's work, so the tab would quietly be showing 9→11 under a
title saying 10. It is **frozen** instead: the next time you look at that tab it
reopens against snapshot 10's own revision, and means what it says again. The
freeze waits for you to look, because a multi-diff cannot be rebuilt without being
focused and an agent finishing a turn must not pull your cursor away. The cost is
that the frozen tab loses its live language server — it is history now.

Tick a file as you read it three ways: the **✓ on the row's own header**, beside
Open File; `⌘⌥V` (`ctrl+alt+v` elsewhere), which marks the row your cursor is in;
or the tick in the tab's title bar, which follows the focused row and says
whether *this* file has been read. The row button is a plain toggle — the row
already says which state it is in.

That row button rides on a proposed VS Code API, which is affordable only
because Octoview runs from source rather than from the marketplace. If a VS Code
update withdraws it the button disappears; nothing else changes, and the
keystroke still works.

A row marked `⇣` is **not the agent's change**. It arrived when HEAD moved under
that snapshot — a pull, a merge, a reset — and the snapshot holds it exactly as
that move left it. A snapshot diffs against the snapshot before it and never
against HEAD, so without the mark someone else's merge reads as the agent's work.
Edit such a file yourself and it goes back to being the agent's: the top layer is
the one that counts, and hiding a real edit would be the worse mistake. `Notes.md`
names the move at the top when there was one.

Edits *you* make between turns are not the agent's either, and a `git apply` moves
no HEAD for the mark to notice. The answer is a second hook, beside the Stop one,
that snapshots when you send a prompt — so your own edits land in a `manual`
snapshot and the agent's turn starts after them:

```json
"UserPromptSubmit": [{ "hooks": [{ "type": "command",
  "command": "node <octoview>/out/cli.js snapshot --agent manual --label 'before the turn'" }]}]
```

Snapshotting is idempotent, so a turn where you changed nothing costs nothing. An
edit made *while* the agent is running still lands in its snapshot — no hook can
separate that.

**A review opens with the files you have already read left out.** The title says
how many — `octoview: snapshots 60→66 net · +1200 −300 · 5 read` — and the **eye**
in the tab's title bar puts them back, or takes them out again. A review where
everything has been read opens whole, because a tab with nothing in it says less
than one that is entirely ticked.

Left out rather than folded, and that is a limit rather than a preference: the
multi-diff editor takes a title and a list of resources and nothing else, and the
only collapse commands VS Code has are `collapseAll` and `expandAll` — all or
nothing. There is no way for an extension to fold one row.

**Ticking a file inside a review reopens the tab**, which is how the row goes
away: a multi-diff's resource list and every row's `✓` are fixed when the tab
opens, so nothing about it can change in place. The row you ticked is the one you
have just finished with, which is why that is worth the scroll position it costs.
Outside a review — a single-file diff — nothing reopens and the status bar
acknowledges the tick instead.

---

## 3. Answering the agent

### 3.1 Batch your comments

Comment on any line while you read. Drafts accumulate — nothing is sent until you
press **Submit Review**, which writes one file:

```
.git/octoview/<lane>/batches/<timestamp>.json
```

and flips those threads to submitted. This is the whole point of the tool: the
agent gets the shape of your review in one reply, not five interruptions.

The agent reads it back with:

```bash
octoview review batch --json
```

### 3.2 Comments follow the code

When the next snapshot lands, an open thread is re-anchored to wherever its exact
lines moved to, following renames. If those lines no longer exist, the thread is
marked **outdated** — GitHub's semantics: still visible, still open, flagged.

A thread stays stamped with the snapshot it was opened against, which is what lets
a dropped snapshot take its comments with it.

### 3.3 Ask the agent about its own change

**Not built yet.** PRD UC-4. Today, quote the hunk into your reply.

---

## 4. Rejecting work

### 4.1 Put one file back

**Revert This Snapshot's Change** on a file row restores it to how it was *before*
that snapshot — working tree only, your index untouched.

Offered only while that snapshot's version is still the one on disk. If a later one
wrote over the file, revert that snapshot first; the row tells you which.

### 4.2 Undo a whole snapshot

The same action on a snapshot row. Its files go back, the snapshot is removed, and
any comments opened against it go with it — a comment about a change that no longer
exists is not a comment about anything.

The later snapshots are **rewritten** so they stop carrying the reverted content.
Skip that and the next snapshot would open by recording your revert as the agent's own
work — a deletion nobody made. Any diff tabs you had open follow the rewritten
snapshots automatically.

### 4.3 Drop a snapshot from the middle

Allowed, as long as every file that snapshot changed can still be given back — that
is, no later one wrote over it. Its number becomes a permanent gap, which is
honest: the ordering never shifts under you.

Dropping a snapshot does not strand the ones after it. The one that follows was
committed with it as its git parent, so the chain stays reachable.

### 4.4 A stash is not a revert

`git stash` puts the working tree back exactly where a snapshot started, which is
indistinguishable from you having undone it — every snapshot goes frozen at once.
Octoview records `refs/stash` with each snapshot, so when the stash has moved
since the last one the row says **stashed**, not reverted, and Drop is refused.
Pop the stash and everything comes back; or take a snapshot, which makes the
stashed state the new starting point.

This is the one guess in the tool. Everything else it shows is derived from git.

### 4.5 A snapshot you reverted piece by piece

Once nothing of a snapshot is left on disk it goes **frozen** — struck through and
greyed, holding its number rather than vanishing, so the snapshots around it keep
their order. Drop it when you want it gone.

---

## 5. Landing what you have reviewed

### 5.1 The three areas

The Snapshots view splits each repo the way Source Control splits changes, with a
third area for the work that has left the review entirely:

```
octoview                     main · 34 snapshots
  › Commits      2 commits
      › c6dfa54  feat(review): net and step diffs…   snapshots 5–13
  ⌄ Reviewed     3 snapshots · through 12 · 1 blocked   [commit]
  ⌄ Unreviewed   2 snapshots
```

Marking a snapshot reviewed moves it up. A snapshot only counts as reviewed when
every file it still changes is marked — until then it sits in **both** areas, showing
the files you have read in one and the files you have not in the other, the way
a half-staged file appears twice in Source Control. Marking the row in
Unreviewed takes the rest of it across.

Commits are read back out of git rather than recorded, so amending or rebasing moves
which snapshots one holds. A commit takes every snapshot whose changes it completes —
including one you staged and committed by hand, which is why the area fills up whether
or not you ever press the commit button. The hover carries the whole commit message.

### 5.2 Commit the reviewed prefix

The **commit** button on the Reviewed area takes snapshots 1..N as one commit.

A commit is a **prefix** of the lane — snapshot 12's content sits on top of snapshot
11's — so only an unbroken run from the earliest one can be landed. Review out of order
and the area says so (`through 12 · 1 blocked`); press commit and a modal names
the snapshot in the way and offers to commit through the last one it can reach.

Adjacency is in the snapshot list, not the numbering: dropping snapshot 30 leaves a hole
in the numbers, and snapshots 29 and 31 still commit together.

One more thing gets in the way, deliberately. A snapshot whose message the **hook**
wrote — rather than the agent describing its own work — is the shape an interrupted
turn leaves behind, and a commit takes that snapshot exactly as it stands, half-done
work included. Both the button and `octoview snapshot commit` stop and say so; the
snapshot row's hover says it earlier, before you get there.

### 5.3 Commit 1–10 now, 11–20 later

This is the case the whole design bends around, and there is **no restore step**.
The content comes from snapshot 10 itself, so the working tree never moves:

```bash
octoview snapshot commit 10 -m "project registry"
```

Snapshots 11+ stay uncommitted on disk exactly as they were. A file snapshot 12
edited again still commits at its **snapshot 10** value, and a file snapshot 4 deleted
is recorded as a deletion. Carry on; commit through snapshot 20 when you get there.

### 5.4 What it costs

Loading a snapshot into the index **replaces whatever was staged**, and your
staged set is your review progress marker. Both the button and the CLI refuse
while anything is staged; only the CLI offers `--force`. Do it between batches,
not mid-review.

### 5.5 After a commit

Committing is invisible to snapshotting — verified, not assumed. The next
snapshot finds an identical working tree and records nothing, so no phantom entry
appears. The lane does not change, the snapshot refs survive, and the numbering
carries on.

What does change: the snapshots the commit covered go dim with a `✓`, and the
"staged" markers clear.

**Landed is derived from content, not from a matching tree.** A snapshot has landed
once every path it changed is in a commit — as that snapshot left it, or as a later
snapshot rewrote it, since work written over still reached the branch through the
work that replaced it.

So your own commits count. Stage the three files you have read, commit them, and the
snapshot they belonged to lands the moment its last file goes in — credited to the
commit that finished it. Half of one lands nothing, which is the honest answer: it
still has work outstanding.

Landing is therefore **not** a prefix. Commit snapshot 2's files and leave snapshot 1's
half done, and 2 lands while 1 waits — a commit's row says `snapshots 2, 5–7` when
that is what it took. The commit *button* is still a prefix (§5.2); that is a rule
about what octoview may commit for you, not about what git has already done.

Nothing is recorded, so amend, reset and rebase all just move the answer.

### 5.6 Letting go of a dead branch

Delete a branch and its lane is left holding refs nobody can reach. Those refs are
**GC roots** — while octoview holds one, `git gc --prune=now` cannot collect the
snapshot. That is the only real leak, and it is why cleanup exists at all.

The repo row goes warning-coloured with a count and grows a bin; `octoview gc
[--dry-run]` does the same from a terminal. Both do exactly one thing: **let go of
the refs.** No commit is deleted. From that moment the snapshots are ordinary
unreachable objects and git's own retention decides — its grace period, then your
next `git gc`. A lane whose objects git has already taken is then forgotten,
because there is nothing left to review.

Octoview has no age window, no per-lane cap, and no opinion about when your work
goes stale. It also never runs `git gc` for you.

**What cannot be undone.** Once git collects them, they are gone: a snapshot commit
sits in *no* reflog, so nothing names it after the ref goes — unlike a deleted
branch, whose commits `git reflog` can still find for 90 days. Until git collects
them, `state.json` holds every sha and a lane can be put back with `git
update-ref`. Widen that window with `gc.pruneExpire` if you want longer.

### 5.7 Reverting after a commit

Revert does not know the work is committed. It will put files back, creating an
uncommitted diff against your own commit — recoverable with `git restore`, but
Octoview will not warn you first. Before a commit a revert is free; after it, it
is an edit you have to deal with in git.

---

## 6. Around the edges

### 6.1 Several repositories

One **Take Snapshot** covers the workspace. Every repo the work actually changed gets
a snapshot; repos it did not touch get none, so numbering never drifts from the work
it describes. Each repo keeps its own state, its own numbering, and its own
commit button.

A repo appears in the view once it has snapshots and not before.

### 6.2 Branches and worktrees

A **lane** is a branch of a worktree. State lives under the clone's common dir,
so every worktree agrees on where it is, and snapshot refs are lane-scoped so two
worktrees of one clone cannot collide.

Switch branches and you are in a different lane: different snapshots, numbering
from 1, a different review. `gh pr checkout` counts.

### 6.3 Working in the terminal at the same time

A `git restore`, an edit, a `git add` — the view follows. It watches the git
extension's state and refreshes on real changes only, so a background `git
status` does not make the rows flicker. A checkout re-discovers the lane.

Snapshots never read or write your index; they go through a private index file, so
`git add -A` inside Octoview cannot touch the set you are curating.

### 6.4 Which agent made a snapshot

Each snapshot row carries its agent's mark: Claude's and Codex's own logos, a
codicon for Copilot, a pencil for a snapshot you took yourself, and a sparkle for
anything else — because an agent this build has never heard of is still an agent.

### 6.5 No hook available

Any agent that can run a command can record a snapshot:

```bash
octoview snapshot --label "what the snapshot did" --agent codex
```

And any agent at all can be reviewed by snapshotting manually before and after
you let it work.

---

## 7. The agent's side

### 7.1 At the end of a turn

The `prepare-change-review` skill is the contract: capture the snapshot, then build
a report from CLI facts rather than from memory of the work.

```bash
octoview status --json        # snapshots so far, files, review state
octoview diff <n> --json      # exactly this snapshot's changed files
octoview show <rev> <path>    # file content at a snapshot, for before/after
```

Report in the human's reading order — schema and model first, then managers, then
call sites — with real numbers for verification and a plain statement of what was
not checked.

That report is also the snapshot's own record: its first line becomes the sidebar
row and the whole of it becomes the note the review opens with. So it leads with
`<kind>: <what the snapshot did>` in one line, then one short paragraph each for
the goal, the approach, the test numbers and where to look — a pull request's
description at one snapshot's scale — and only then the per-file detail. The note
is a diff row, which renders no markdown, so the skill tells agents to write it
as plain text rather than as markup you would have to read through.

An agent may snapshot several times in one turn, and the skill tells it to: one
snapshot per unit of work, so each part arrives with its own message, reverts on
its own, and can be the point a commit stops at.

### 7.2 Picking up a branch it does not remember

The snapshot messages are written to be read by a human, and they turn out to be
the best context an *agent* can inherit too. They live in the repository rather
than in a session, so they survive what sessions do not: a compaction, a crash, a
new window opened on the same branch a day later with no handoff.

The `recover-change-context` skill is the other half of the contract, and it is
deliberately lazy — reached for only when an agent cannot account for the work
already in the tree, and abandoned as soon as it can. Cheapest rung first:

```bash
octoview status               # one line per snapshot: label, files, review state
octoview status --json        # …and the full message each agent left
octoview diff <n>             # what that snapshot actually changed
octoview review batch --json  # what you said back, which is often the real job
```

It also says what the record cannot tell them: a message is what an agent
believed as it finished, so where it disagrees with the tree, the tree wins — you
may have reverted a file or dropped a snapshot since.

### 7.3 What an agent must never do

- Touch the index. The staged set is the human's review progress marker.
- Mark anything reviewed, approved or waived. That boundary is the product.
- Commit uninvited. `octoview snapshot commit` exists so the human's instruction can
  be carried out, not so an agent can decide to land work — and the instruction
  is scoped to the message it was given in.
- Read or write `.git/octoview/` directly. The CLI owns that state and its
  locking; two writers share it.

---

## 8. Not built yet

| | |
|---|---|
| Ask the agent from a comment thread | PRD UC-4 |
| Review a GitHub PR through the same ritual | PRD UC-5 |
| Sharing batches beyond the local repo | Octomate sync, PRD §5.6 (M5) |
| Plans and other artifacts as reviewable snapshots | PRD §4.7 |
