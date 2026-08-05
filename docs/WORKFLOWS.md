# Working with an agent through Octoview

The situations this tool is for, and what each side does in them.
[PRD §3](PRD.md) states the use cases as requirements; this is the practical
companion — what you click, what the agent runs, and what Octoview does in
between. Everything here works against the current build unless it is marked
**not built yet**.

The unit is the **turn**: one agent reply, captured as a real git commit under
`refs/octoview/turns/<lane>/<n>`, diffed against the turn before it. Your index,
your HEAD and your branches are never touched.

---

## 1. The everyday loop

### 1.1 The agent finishes; you review

The Stop hook snapshots the working tree the moment the agent stops:

```bash
octoview turn snapshot --from-stop-hook   # reads the hook payload on stdin
```

It takes the repo, the session id and a label from the transcript, so the turn
arrives already named. The Turns view notices — a file watch on the lane's state
directory, not a service — and the new turn appears at the bottom, expanded.

You open a file, read **turn N-1 → turn N**, and mark what you have cleared. The
agent is free to keep working the whole time; nothing you do blocks it.

### 1.2 You stepped away and it ran six turns

Read the delta, not the branch. A file you cleared at turn 2 that nobody has
touched since stays cleared; a file turn 5 touched is open again. The whole rule
is `reviewed[file] >= turn`, so nothing has to be recomputed or invalidated.

Select turns 3–6 and press **Open Net Diff of Selected Turns** to read them as
one change, or walk them one at a time. A non-contiguous selection works too —
ctrl-click turns 3 and 6 — and the diff shows only what those two did, not the
turns in the gap.

### 1.3 You want to stop mid-turn

Interrupt the agent and run **Octoview: Snapshot Turn** yourself. A manual
snapshot is a first-class entry point, not a fallback: it records whatever exists
right now as its own turn, and the agent's next turn diffs against it.

If nothing has changed since the last turn, no turn is taken — snapshotting is
idempotent, so an idle interrupt cannot pollute the numbering.

---

## 2. Reading a change

| you want | do this |
|---|---|
| one file, one turn | click the file row under the turn |
| everything one turn did | click the turn row |
| several turns as one change | select them, then **Open Net Diff of Selected Turns** |
| everything you have approved | click the **Reviewed** area row |
| one file's evolution across turns | **Open Step History** on the file row |
| the whole lane | click the repo row |

The first row of a multi-file review is `agent notes.md`: what the agent said
when it finished each of the turns you selected, in full. The tree row and the
tab title have room for its first line only — this is the rest of it, and it is
meant to be read before the diff. The `prepare-change-review` skill is what tells
an agent to close a turn with a message worth putting there: kind, goal, how,
test numbers, what to look at.

For the **newest** turn the right-hand side of a diff is the real file on disk,
so the language server attaches — hover, types and go-to-definition all work
while you read. Older turns diff two snapshot revisions and are read-only by
nature.

A multi-diff row header shows `✓ files.ts` once you have marked that file viewed.
It is baked in when the tab opens, so ticking a file elsewhere does not update an
already-open review — reopen it, or use **Mark All Files Viewed**, which reopens
the tab for you.

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

When the next turn lands, an open thread is re-anchored to wherever its exact
lines moved to, following renames. If those lines no longer exist, the thread is
marked **outdated** — GitHub's semantics: still visible, still open, flagged.

A thread stays stamped with the turn it was opened against, which is what lets a
dropped turn take its comments with it.

### 3.3 Ask the agent about its own change

**Not built yet.** PRD UC-4. Today, quote the hunk into your reply.

---

## 4. Rejecting work

### 4.1 Put one file back

**Revert This Turn's Change** on a file row restores it to how it was *before*
that turn — working tree only, your index untouched.

Offered only while that turn's version is still the one on disk. If a later turn
wrote over the file, revert that turn first; the row tells you which.

### 4.2 Undo a whole turn

The same action on a turn row. Its files go back, the turn is removed, and any
comments opened against it go with it — a comment about a change that no longer
exists is not a comment about anything.

The later turns are **rewritten** so they stop carrying the reverted content. Skip
that and the next snapshot would open by recording your revert as the agent's own
work — a deletion nobody made. Any diff tabs you had open follow the rewritten
snapshots automatically.

### 4.3 Drop a turn from the middle

Allowed, as long as every file that turn changed can still be given back — that
is, no later turn wrote over one. Its number becomes a permanent gap, which is
honest: the ordering never shifts under you.

Dropping a turn does not strand the ones after it. The turn that follows was
committed with it as its git parent, so the chain stays reachable.

### 4.4 A turn you reverted piece by piece

Once nothing of a turn is left on disk it goes **frozen** — struck through and
greyed, holding its number rather than vanishing, so the turns around it keep
their order. Drop it when you want it gone.

---

## 5. Landing what you have reviewed

### 5.1 The three areas

The Turns view splits each repo the way Source Control splits changes, with a
third area for the work that has left the review entirely:

```
octoview                     main · 34 turns
  › Commits      2 commits
      › 787ff1f  feat(review): net and step diffs…   turns 5–13
  ⌄ Reviewed     3 turns · through 12 · 1 blocked   [commit]
  ⌄ Unreviewed   2 turns
```

Marking a turn reviewed moves it up. A turn only counts as reviewed when every
file it still changes is marked — until then it sits in **both** areas, showing
the files you have read in one and the files you have not in the other, the way
a half-staged file appears twice in Source Control. Marking the row in
Unreviewed takes the rest of it across.

Commits are read back out of git rather than recorded: a commit made from turn
13's snapshot *is* turn 13's tree, so amending or rebasing moves which turns it
holds. The hover carries the whole commit message.

### 5.2 Commit the reviewed prefix

The **commit** button on the Reviewed area takes turns 1..N as one commit.

A commit is a **prefix** of the lane — turn 12's content sits on top of turn 11's —
so only an unbroken run from the earliest turn can be landed. Review out of order
and the area says so (`through 12 · 1 blocked`); press commit and a modal names
the turn in the way and offers to commit through the last one it can reach.

Adjacency is in the turn list, not the numbering: dropping turn 30 leaves a hole
in the numbers, and turns 29 and 31 still commit together.

One more thing gets in the way, deliberately. A turn whose message the **hook**
wrote — rather than the agent describing its own work — is the shape an
interrupted turn leaves behind, and a commit takes that turn's snapshot exactly
as it stands, half-done work included. Both the button and `octoview turn commit`
stop and say so; the turn row's hover says it earlier, before you get there.

### 5.3 Commit 1–10 now, 11–20 later

This is the case the whole design bends around, and there is **no restore step**.
The content comes from turn 10's snapshot, so the working tree never moves:

```bash
octoview turn commit 10 -m "project registry"
```

Turns 11+ stay uncommitted on disk exactly as they were. A file that turn 12
edited again still commits at its **turn 10** value, and a file turn 4 deleted is
recorded as a deletion. Carry on; commit through turn 20 when you get there.

### 5.4 What it costs

Loading a snapshot into the index **replaces whatever was staged**, and your
staged set is your review progress marker. Both the button and the CLI refuse
while anything is staged; only the CLI offers `--force`. Do it between batches,
not mid-review.

### 5.5 After a commit

Committing is invisible to snapshotting — verified, not assumed. The next
snapshot finds an identical working tree and records nothing, so no phantom turn
appears. The lane does not change, the turn refs survive, and the numbering
carries on.

What does change: turns the commit covered go dim with a `✓`, and the "staged"
markers clear.

**Landed is a prefix, derived from git:** the newest turn whose tree *is* HEAD's
tree, and everything before it. A partial commit that matches no snapshot lands
no turn — honestly, since it completed none of them. Individual files still show
`committed` when the working tree matches HEAD, which is where partial progress
shows up.

Nothing is recorded, so amend, reset and rebase all just move the answer.

### 5.6 Reverting after a commit

Revert does not know the work is committed. It will put files back, creating an
uncommitted diff against your own commit — recoverable with `git restore`, but
Octoview will not warn you first. Before a commit a revert is free; after it, it
is an edit you have to deal with in git.

---

## 6. Around the edges

### 6.1 Several repositories

One **Snapshot Turn** covers the workspace. Every repo the turn actually changed
gets a turn; repos it did not touch get none, so numbering never drifts from the
work it describes. Each repo keeps its own state, its own numbering, and its own
commit button.

A repo appears in the view once it has turns and not before.

### 6.2 Branches and worktrees

A **lane** is a branch of a worktree. State lives under the clone's common dir,
so every worktree agrees on where it is, and turn refs are lane-scoped so two
worktrees of one clone cannot collide.

Switch branches and you are in a different lane: different turns, numbering from
1, a different review. `gh pr checkout` counts.

### 6.3 Working in the terminal at the same time

A `git restore`, an edit, a `git add` — the view follows. It watches the git
extension's state and refreshes on real changes only, so a background `git
status` does not make the rows flicker. A checkout re-discovers the lane.

Turn snapshots never read or write your index; they go through a private index
file, so `git add -A` inside Octoview cannot touch the set you are curating.

### 6.4 Which agent made a turn

Each turn row carries its agent's mark: Claude's and Codex's own logos, a codicon
for Copilot, a pencil for a turn you snapshotted yourself, and a sparkle for
anything else — because an agent this build has never heard of is still an agent.

### 6.5 No hook available

Any agent that can run a command can record a turn:

```bash
octoview turn snapshot --label "what the turn did" --agent codex
```

And any agent at all can be reviewed by snapshotting manually before and after
you let it work.

---

## 7. The agent's side

### 7.1 At the end of a turn

The `prepare-change-review` skill is the contract: capture the turn, then build a
report from CLI facts rather than from memory of the work.

```bash
octoview status --json        # turns so far, files, review state
octoview diff <n> --json      # exactly this turn's changed files
octoview show <rev> <path>    # file content at a turn, for before/after
```

Report in the human's reading order — schema and model first, then managers, then
call sites — with real numbers for verification and a plain statement of what was
not checked.

That report is also the turn's own record: its first line becomes the sidebar row
and the whole of it becomes the note the review opens with. So it leads with
`<kind>: <what the turn did>` in one line, then a paragraph giving the goal, the
approach, the test numbers and where to look — a pull request's description at
one turn's scale — and only then the per-file detail.

### 7.2 What an agent must never do

- Touch the index. The staged set is the human's review progress marker.
- Mark anything reviewed, approved or waived. That boundary is the product.
- Commit uninvited. `octoview turn commit` exists so the human's instruction can
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
| Plans and other artifacts as reviewable turns | PRD §4.7 |
