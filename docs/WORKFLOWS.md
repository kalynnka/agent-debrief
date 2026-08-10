# Working with an agent through Debrief

The situations this tool is for, and what each side does in them.
[PRD §3](PRD.md) states the use cases as requirements; this is the practical
companion — what you click, what the agent runs, and what Debrief does in
between. Everything here works against the current build unless it is marked
**not built yet**.

The unit is the **snapshot**: one agent turn's work, captured as a real git commit
under `refs/debrief/snapshots/<lane>/<n>` and diffed against the snapshot before
it. Your index, your HEAD and your branches are never touched.

---

## 1. The everyday loop

### 1.1 The agent finishes; you review

**The agent snapshots its own work**, and picks the moments: that is what
`prepare-change-review` (§7.1) has it do, one snapshot per piece of work finished rather
than one per turn. The Snapshots view notices — a file watch on the lane's state
directory, not a service — and each new snapshot appears at the bottom, expanded.

**Take Snapshot** is the same thing by hand, for the gaps: one before you set an agent
going, one to fence off your own edits, one for an agent that cannot run a command.

A Stop hook makes it a guarantee rather than an instruction, for a repo where you want
that:

```bash
debrief snapshot --from-stop-hook   # reads the hook payload on stdin
```

It takes the repo and the session id from the payload, and a label from the turn's
closing message — which is the best it can do and worse than what the agent writes when
it snapshots deliberately. On a tree already snapshotted it records nothing, so it costs
nothing to have. §6.5 is where it goes and where it must not.

The Debrief icon in the activity bar carries a **badge**: how much is still
waiting on you, so a turn that finished while the panel was closed still
announces itself. It counts the snapshots no commit has taken — the **Open**
area exactly — so it empties once you have landed the lane, the way Source
Control's own number empties when the tree is clean. A running total of
everything ever snapshotted would only ever climb, and a number that never falls
stops being read.

It counts exactly what the view would draw, so a repo you have unchecked (§6.1)
takes its snapshots off the icon with it, and a lane with nothing outstanding
carries no badge rather than a zero.

You open a file and read **snapshot N-1 → snapshot N**. The agent is free to keep
working the whole time; nothing you do blocks it.

### 1.2 You stepped away and it took six snapshots

Read the delta, not the branch: each snapshot's diff is its own change, so six of
them are six changes rather than one pile.

Select snapshots 3–6 and press **Open Net Diff of Selected Snapshots** on the
repo's row to read them as one change, or walk them one at a time. A
non-contiguous selection works too — ctrl-click snapshots 3 and 6 — and the diff
shows only what those two did, not the snapshots in the gap.

### 1.3 You want to stop mid-turn

Interrupt the agent and press **Take Snapshot** on the repo's row yourself. A
manual snapshot is a first-class entry point, not a fallback: it records whatever
exists right now as its own snapshot, and the agent's next one diffs against it.

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
| several snapshots as one change | select them, then **Open Net Diff of Selected Snapshots** on the repo row |
| everything not yet committed | click the **Open** area row |
| one file's evolution across snapshots | **Open Step History** on the file row |
| the whole lane | click the repo row |

The first row of every review is `Notes.md`: each selected snapshot's
label, and the few lines the agent left under it. The tree row has room for the
label alone; this is the rest, and it is meant to be read before the diff. A
review of a single file opens as a one-row multi-diff for this reason — the note
is worth more than the empty space a plain diff would save. It is
a diff row like any other, so it shows the text as text. The
`prepare-change-review` skill is what keeps it worth reading: one sentence as the
label, then Purpose and Verification, and a Risks line only when there is a real
one — in plain text, because nothing renders that row. Everything longer belongs
in the agent's reply, where you can see it beside the rest of the conversation.

Hovering a snapshot's row in the sidebar shows its state and the message's
opening section, rendered. A hover clips rather than scrolls, so the rest is a
click away: **Read the whole note** opens the message as its own document, which
scrolls and copies like any other. (VS Code's own `⌘K ⌘I` focuses a hover and
makes it scrollable, if you would rather stay there.)

A `src/review.ts:270` in a note is a **link** — in the note and in the hover both.
Click it and the file opens at that line. Nothing renders that row, so agents are
told to write references plainly rather than as markdown; debrief finds them
afterwards and underlines them where they stand. They point at the file on disk,
which is the copy with a language server attached, so a reference to a file since
deleted is left as plain text rather than given a link that goes nowhere.

For the **newest** snapshot the right-hand side of a diff is the real file on disk,
so the language server attaches — hover, types and go-to-definition all work while
you read. Older snapshots diff two revisions and are read-only by nature.

That has an edge, and Debrief handles it rather than leaving it to you. A review
of snapshot 10, opened while 10 was newest, points at the file; when snapshot 11
lands, the file holds 11's work, so the tab would quietly be showing 9→11 under a
title saying 10. It is **frozen** instead: the next time you look at that tab it
reopens against snapshot 10's own revision, and means what it says again. The
freeze waits for you to look, because a multi-diff cannot be rebuilt without being
focused and an agent finishing a turn must not pull your cursor away. The cost is
that the frozen tab loses its live language server — it is history now.

Marking a file as read is **switched off** — §5.2 says why, and what came off
with it. Reviews open whole.

A row marked `⇣` is **not the agent's change**. It arrived when HEAD moved under
that snapshot — a pull, a merge, a reset — and the snapshot holds it exactly as
that move left it. A snapshot diffs against the snapshot before it and never
against HEAD, so without the mark someone else's merge reads as the agent's work.
Edit such a file yourself and it goes back to being the agent's: the top layer is
the one that counts, and hiding a real edit would be the worse mistake. `Notes.md`
names the move at the top when there was one.

Edits *you* make between turns are not the agent's either, and a `git apply` moves
no HEAD for the mark to notice. Snapshotting before you send a prompt is the answer —
your own edits land in a `manual` snapshot and the agent's turn starts after them. Press
the camera, or, in a repo already running the Stop hook of §6.5, let a second one beside
it do the same:

```json
"UserPromptSubmit": [{ "hooks": [{ "type": "command",
  "command": "debrief snapshot --agent manual --label 'before the turn'" }]}]
```

Snapshotting is idempotent, so a turn where you changed nothing costs nothing. An
edit made *while* the agent is running still lands in its snapshot — no hook can
separate that.

---

## 3. Answering the agent

### 3.1 Batch your comments

Comment on any line while you read. Each one is **open** the moment you write it:
there is no send step, and nothing to remember at the end of a read. Say "I have
reviewed" and the agent picks the lot up.

That still gets you the batch, because the batching was never the button. Nothing
pushes a comment at an agent — an agent *asks*, once, when you next speak to it,
so it gets the shape of your review in one reply rather than five interruptions.
The button only ever added a way to lose a comment you forgot to press it for,
and it is gone.

`debrief review submit` remains, for the other half of the button's old job: it
writes what is open to one file —

```
.git/debrief/<lane>/batches/<timestamp>.json
```

— which is the record, and the thing that leaves this repository. It changes
nothing you can see: a thread stays open and keeps taking replies until the ✓.

The agent reads your comments with:

```bash
debrief review open               # every comment still waiting, across submits
debrief review reply <id> -m "…"  # what it did about one
debrief review resolve <id>…      # close it — only when you ask
```

`review open` is the one to work from — `review batch` is still there and answers
a different question, the contents of one submit as a record.

The loop is four steps, and the ✓ is yours:

1. You write comments. Each is open from the moment it is written.
2. You tell the agent to look; it reads them with `review open`.
3. It fixes what it can and answers each thread with `review reply`. The answer
   appears under your comment on the file, within a moment.
4. You read the answer and click **✓** in the thread's title bar when it satisfies
   you.

An answered thread is still open and still printed by `review open`, because it is
waiting on you now rather than on the agent. The `prepare-change-review` skill
tells agents not to close their own work — `review resolve` is for when you say
so, which is also how "mark them all as resolved" gets done.

### 3.2 Handing the review over

Your comments are open as soon as they are written; getting them in front of an
agent is a separate step, and there are three ways because no two people run
their agent the same way.

**The agent asks.** Nothing to press at all: it runs `debrief review open` at the
start of a turn, and everything you wrote is there. This is the one that costs you
nothing and the one to prefer.

**Copy Review for the Agent** (the clipboard on the repo's row) submits what is
open, renders it as plain text, puts it on the clipboard, and
focuses the agent's input if the Claude Code extension is installed. You press
⌘V. That last step stays yours: an extension cannot paste into another
extension's webview, and focusing the input is the whole of what Claude Code
exposes. It also @-mentions the file you were looking at on the way in, which is
its behaviour and not ours.

**Send Review to the Agent's Terminal** (right-click the repo's row) does the same
and types it into a terminal instead — the active one, or one you pick. It
arrives as a *paste* rather than as typing, so a review of six comments does not
send its first line as the whole prompt. It stops short of Enter, so you read it
before it goes.

Both act on what is **open**, not on what you just wrote, so pressing either one
twice sends the same comments again until the agent resolves them.

### 3.3 Comments follow the code

When the next snapshot lands, an open thread is re-anchored to wherever its exact
lines moved to, following renames. If those lines no longer exist, the thread is
marked **outdated** — GitHub's semantics: still visible, still open, flagged.

Comment on an **older** snapshot's diff and the thread makes that whole journey at
once, the moment you write it: its lines are found again in the newest version of
the file, so the comment sits on the line as it stands now and `review open` sends
the agent to a line number that is true today. A line the later snapshots took
away leaves the comment outdated, which is the same answer for the same reason.

A thread is stamped with **the diff you were reading**, not with the newest
snapshot and not with the revision under your cursor: comment on a line snapshot 6
deleted — the left-hand side, which holds snapshot 5's content — and it is still
snapshot 6 you are reviewing. That is GitHub's rule, and it is what keeps a
dropped snapshot taking its own comments with it.

A thread is drawn in **one** place, and which place says whether its lines are
still there. While they are, it sits on the file at the relocated line, which is
where you would go to act on it. Once they are gone it moves to the diff it was
written against and sits where you put it, because that diff never changes and
the file no longer has an honest position to offer. One home either way: two
would list the same comment twice in the Comments panel.

The exception is the tab you are typing in. A comment written on an older diff
stays visible there until you close it, because taking it out from under your
cursor to redraw it on a file you may not have open is worse than a second row
for as long as you are looking at it.

**A resolved thread is drawn nowhere.** It disappears from the file the moment it
is closed — by your ✓, or by the agent when you told it to — because on a lane
moving at a
snapshot a turn a widget over answered lines is in the way within minutes. The
thread itself stays in `state.json` — `review resolve` closes a comment, it does
not delete it — and `debrief review open` remains the answer to what is left.

### 3.4 Ask the agent about its own change

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
Debrief records `refs/stash` with each snapshot, so when the stash has moved
since the last one the row says **stashed**, not reverted, and Drop is refused.
Pop the stash and everything comes back; or take a snapshot, which makes the
stashed state the new starting point.

This is the one guess in the tool. Everything else it shows is derived from git.

### 4.5 A snapshot you reverted piece by piece

Once nothing of a snapshot is left on disk it goes **frozen** — struck through and
greyed, holding its number rather than vanishing, so the snapshots around it keep
their order. Drop it when you want it gone.

### 4.6 Forget a snapshot, keep the files

**Forget This Snapshot** — the bin on a snapshot row — takes it out of the list and
touches nothing on disk. Drop's opposite: that one reverts and then forgets, this one
only forgets. It is for work you have decided not to *review*, not work you want undone.

It is also the only way out for a row Drop cannot reach. A snapshot a later one wrote
over has nothing left to give back, so reverting it is refused and it stays in the list
for good.

What it costs is that turn's review. The snapshot after it still diffs against its
commit, so the change stays on the branch and stops being anything the review can show.
Forget the newest one and the work has nowhere to go but the next snapshot, which picks
it up as its own. Comments written on it go either way.

---

## 5. Landing what you have reviewed

### 5.1 The two areas

The Snapshots view splits each repo into what has landed and what has not:

```
debrief                     main · 34 snapshots
  › Commits      2 commits · 9 snapshots
      › c6dfa54  feat(review): net and step diffs…   snapshots 5–13
  ⌄ Open         5 snapshots
```

It used to be three, with **Reviewed** in the middle and marking a snapshot read
as the way across. That is **off** — see §5.2 — so everything a commit has not
taken sits in **Open**, oldest first.

Commits are read back out of git rather than recorded, so amending or rebasing moves
which snapshots one holds. A commit takes every snapshot whose changes it completes —
including one you staged and committed by hand, which is why the area fills up whether
or not you ever run the commit command. The hover carries the whole commit message.

### 5.2 Marking a file read is switched off

Ticking a file as you read it, and the **Reviewed** area it fed, are gone from
the UI for now. The rule was `reviewed[file] >= snapshot`: a file you cleared at
snapshot 2 was open again the moment snapshot 5 touched it. That is cheap to
compute and, across a lane of thirty, more than a reader can hold — which is the
whole reason it is off rather than being refined.

Nothing was deleted. Marks already recorded stay in `state.json`, and one
constant — `MARKING` in `src/state.ts` — is what ignores them, so the feature
comes back with that line and the menu entries in `package.json`. It is switched
off at the source rather than only in the manifest, because marks still on disk
would otherwise go on hiding files from reviews with nothing left to clear them by.

Gone with it: the ✓ on a diff row's header, `⌘⌥V`, **Mark All Files Viewed**, the
**eye** that put read files back into a review, and the commit button, which was
gated entirely on marks. Reviews now open whole, every time.

### 5.3 Committing is git's

There is no debrief command for it, and there is no button. You stage what you have
read and commit it, the way you would in a repo with no debrief in it at all:

```bash
git add src/core/review.ts
git commit -m "…"
```

Debrief's only part is reading the result back. It never writes your index, never moves
`HEAD`, and never commits on your behalf — which is the §1.3 invariant with the last
exception taken out of it. `debrief snapshot commit` used to be that exception: it
loaded a snapshot into your real index and committed it, which meant refusing whenever
anything was staged, because staging is your progress marker. Both the command and the
refusal are gone.

Nothing warns you any more about committing a snapshot the **hook** described rather
than the agent — the shape an interrupted turn leaves behind. That check lived in the
removed command. The snapshot row's hover still says which snapshots nobody stood
behind; reading it before you stage is now the whole of the guard.

### 5.4 Commit 1–10 now, 11–20 later

Still the case the design bends around, and it needs nothing special: stage the files
snapshots 1–10 left and commit them. Snapshots 11+ stay uncommitted on disk exactly as
they were.

The difference from the old command is **what content lands**. It committed snapshot
10's tree, so a file snapshot 12 had edited again went in at its snapshot-10 value. Git
stages what is on disk, so that file goes in as snapshot 12 left it. If you want the
older content, that is `git add -p`, or a revert first — debrief no longer offers a
third way.

Landing is therefore not a prefix, and never really was on git's side — see §5.6.

### 5.6 After a commit

Committing is invisible to snapshotting — verified, not assumed. The next
snapshot finds an identical working tree and records nothing, so no phantom entry
appears. The lane does not change, the snapshot refs survive, and the numbering
carries on.

What does change: the snapshots the commit covered move into **Commits**, the
"staged" markers clear, and the badge on the activity-bar icon drops by what the
commit took — to nothing at all when it took the lot.

**Landed is derived from content, not from a matching tree.** A snapshot has landed
once every path it changed is in a commit — as that snapshot left it, or as a later
snapshot rewrote it, since work written over still reached the branch through the
work that replaced it.

Your commits are the only commits, and they count without being told to. Stage the
three files you have read, commit them, and the snapshot they belonged to lands the
moment its last file goes in — credited to the commit that finished it. Half of one
lands nothing, which is the honest answer: it still has work outstanding.

Landing is therefore **not** a prefix. Commit snapshot 2's files and leave snapshot 1's
half done, and 2 lands while 1 waits — a commit's row says `snapshots 2, 5–7` when that
is what it took. Nothing constrains you to an unbroken run any more; the rule that did
belonged to the removed command, not to git.

Nothing is recorded, so amend, reset and rebase all just move the answer.

### 5.7 Letting go of a dead branch

Delete a branch and its lane is left holding refs nobody can reach. Those refs are
**GC roots** — while debrief holds one, `git gc --prune=now` cannot collect the
snapshot. That is the only real leak, and it is why cleanup exists at all.

The repo row goes warning-coloured with a count and grows a bin; `debrief gc
[--dry-run]` does the same from a terminal. Both do exactly one thing: **let go of
the refs.** No commit is deleted. From that moment the snapshots are ordinary
unreachable objects and git's own retention decides — its grace period, then your
next `git gc`. A lane whose objects git has already taken is then forgotten,
because there is nothing left to review.

Debrief has no age window, no per-lane cap, and no opinion about when your work
goes stale. It also never runs `git gc` for you.

**What cannot be undone.** Once git collects them, they are gone: a snapshot commit
sits in *no* reflog, so nothing names it after the ref goes — unlike a deleted
branch, whose commits `git reflog` can still find for 90 days. Until git collects
them, `state.json` holds every sha and a lane can be put back with `git
update-ref`. Widen that window with `gc.pruneExpire` if you want longer.

### 5.8 Letting go of the branch you are on

The sweep waits for a branch to die. When a review on a *live* branch has served
its purpose — the work is committed, or you simply want to start the branch's
review over — right-click the repo row: **Delete This Branch's Snapshots**. It is
in the context menu rather than on the row, because a permanent bin beside every
repo is one misclick from a review you cannot get back.

Same rule as the sweep: debrief lets go of the refs and deletes no commit. The
difference is the record. A dead lane keeps its `state.json`, so `git update-ref`
can put it back while the objects last; this **empties** it, so nothing anywhere
remembers the shas. The modal counts what is already in a commit against what is
not, says how many unanswered comments go with them, and tells you the next snapshot
here will be number 1 again.

One thing is kept and it is not a snapshot: **where the lane now starts.** An
empty lane would fall back to HEAD, so the next agent turn would open by claiming
every uncommitted change already sitting in your tree. Clearing writes that tree
as a commit and points the lane at it, so the next snapshot shows what the agent
did and nothing else. Nothing to read, nothing to review — one ref, which the
sweep lets go of with the rest when the branch dies. A clean tree records
nothing, because HEAD already says the same thing.

### 5.9 Reverting after a commit

Revert does not know the work is committed. It will put files back, creating an
uncommitted diff against your own commit — recoverable with `git restore`, but
Debrief will not warn you first. Before a commit a revert is free; after it, it
is an edit you have to deal with in git.

---

## 6. Around the edges

### 6.1 Several repositories

**Every action belongs to a repository, and its buttons are on that repository's
row.** Hover it and you get: take a snapshot, open the net diff of what you have
selected, submit your review, copy it for the agent — and, in the right-click
menu, send it to a terminal or delete the lane's snapshots. Only **Refresh** is
in the view's title bar, because only Refresh is about the view rather than about
a repo.

That is a change from one button covering the workspace. A snapshot of five repos
at once records four of them for work that happened in the fifth, and a review
submitted across the workspace goes to whichever agent reads it first. Each repo
keeps its own state, its own numbering and its own review; the buttons now say so.

**Everything is also in the command palette** — `⌘⇧P`, then "Debrief". A command
that would normally act on a row takes the row you have **selected** in the view,
and tells you when nothing is selected. A repo-scoped one takes the repo whose
review you are looking at, or the only one in the workspace, and asks when it is
neither. The only commands not in the palette are the three that add, reply to and
delete a review comment: their argument is a comment widget VS Code owns, and the
palette has no way to hand one over.

A repo appears in the view once it has snapshots and not before.

**Choosing which repos to read.** A workspace of several clones is usually
several clones you are not reviewing at once. A **Repositories** view sits above
Snapshots with a checkbox per repo — Source Control's own section, and the same
gesture — and unchecking one takes it out of the Snapshots view. It appears only
when the workspace holds more than one repo, because a list whose single row can
only be switched off is a worse offer than no list.

It is a filter on the *view* and on nothing else. Snapshots are still taken in
every repo the work touched, and an unchecked repo keeps its numbering, its state
and its open comments — hiding one is not dropping it, and checking it back on
brings the review back exactly as it was. The choice is remembered per workspace,
and it remembers what you *unchecked*, so a clone added to the workspace tomorrow
arrives visible rather than silently absent.

If you hide everything, the Snapshots view says so rather than claiming there is
nothing to review, and offers **Show All Repositories** — also in the palette,
which is the way back when the workspace has shrunk to the one repo you hid.

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
`git add -A` inside Debrief cannot touch the set you are curating.

### 6.4 Which agent made a snapshot

Each snapshot row carries its agent's mark: Claude's and Codex's own logos, a
codicon for Copilot, a pencil for a snapshot you took yourself, and a sparkle for
anything else — because an agent this build has never heard of is still an agent.

### 6.5 Hooks, and where they belong

A hook earns its place in a repository you are reviewing turn by turn and nowhere else.
It goes in **that project's** `.claude/settings.json`:

```json
"hooks": {
  "Stop": [{ "hooks": [{ "type": "command",
    "command": "/bin/sh -c 'debrief snapshot --from-stop-hook >/dev/null; exit 0'"
  }]}]
}
```

**Not in `~/.claude/settings.json`.** A hook there fires in every repository you open, so
every clone you touch starts accumulating snapshot refs and a badge for work nobody is
going to read. The benefit is per-repo; so is the cost.

It is also why the Claude Code plugin ships **no hook**. A plugin installs globally, so a
hook inside one is a global hook by construction. The plugin carries what is safe
everywhere — the skills, and `debrief` on the Bash tool's PATH.

**Codex** is the same shape. Its lifecycle hooks deliver a `Stop` payload with the fields
debrief already reads — `session_id`, `cwd`, `transcript_path`, `last_assistant_message`,
on stdin — so the command is unchanged but for the agent name. `<repo>/.codex/hooks.json`:

```json
{ "hooks": { "Stop": [{ "hooks": [{ "type": "command",
  "command": "debrief snapshot --from-stop-hook --agent codex" }] }] } }
```

Its skills are the same `SKILL.md` files, copied or symlinked into
`<repo>/.agents/skills/`. Skills are model-invoked and cost nothing when they do not
apply, so `~/.agents/skills/` is fine for those — the global rule above is about hooks.

**Any other agent** that can run a command can record its own:

```bash
debrief snapshot --label "what the snapshot did" --agent copilot
```

And any agent at all can be reviewed by snapshotting manually before and after you let it
work.

---

## 7. The agent's side

### 7.1 At the end of a turn

The `prepare-change-review` skill is the contract: capture the snapshot, then build
a report from CLI facts rather than from memory of the work.

```bash
debrief status --json        # snapshots so far, files, review state
debrief diff <n> --json      # exactly this snapshot's changed files
debrief show <rev> <path>    # file content at a snapshot, for before/after
```

Report in the human's reading order — schema and model first, then managers, then
call sites — with real numbers for verification and a plain statement of what was
not checked.

The snapshot's own record is the summary of that report, not the report, and it
is two separate fields. The **label** is one sentence and becomes the sidebar
row; the **message** is Purpose and Verification, plus Risks on the snapshots
that have one, and opens the review above the diff. Neither is the other cut in half, and
the CLI refuses a message with no label, because a label sliced off the front of
something else is how a row ends up reading like the middle of a turn. Everything
that does not fit stays in the reply, where you can see it beside the rest of the
answer. The note is a diff row, which renders no markdown, so the skill tells
agents to write plain text rather than markup you would have to read through.

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
debrief status               # one line per snapshot: label, files, review state
debrief status --json        # …and the full message each agent left
debrief diff <n>             # what that snapshot actually changed
debrief review batch --json  # what you said back, which is often the real job
```

It also says what the record cannot tell them: a message is what an agent
believed as it finished, so where it disagrees with the tree, the tree wins — you
may have reverted a file or dropped a snapshot since.

### 7.3 What an agent must never do

- Touch the index. The staged set is the human's review progress marker.
- Approve or waive anything. That boundary is the product, and it is the human's
  side of it.
- Commit. Not uninvited, and not when invited either — debrief has no command for it,
  and `git commit` is the human's. An agent asked to land work says what to run.
- Read or write `.git/debrief/` directly. The CLI owns that state and its
  locking; two writers share it.

---

## 8. Not built yet

| | |
|---|---|
| Ask the agent from a comment thread | PRD UC-4 |
| Review a GitHub PR through the same ritual | PRD UC-5 |
| Sharing batches beyond the local repo | Octomate sync, PRD §5.6 (M5) |
| Plans and other artifacts as reviewable snapshots | PRD §4.7 |
