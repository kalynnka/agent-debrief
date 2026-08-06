---
name: recover-change-context
description: Recover what earlier agents did on this branch from their octoview snapshots — the message each one left and the files it changed. Use when you are picking up work you did not do and cannot account for: a new session on an existing branch, uncommitted changes of unknown origin, a summary that lost the details, or a question about "what has been done so far".
---

# Recover the change context

Every agent turn on a branch leaves a snapshot: a real git commit holding the
working tree as it stood, plus the message that agent wrote about its own work.
That record lives in the repository, not in any session, so it outlives the
session that made it — a compaction, a crash, a new window opened on the same
branch tomorrow.

**This is a fallback, not a ritual.** Reach for it only when you cannot answer
"what happened here?" from what is already in front of you, and stop the moment
you can act. Every step below costs context; do not spend one you do not need.

## When it is worth doing

Reach for it when you find yourself in one of these:

- The working tree holds changes you did not make, and the request assumes you
  know what they are.
- The user says "carry on", "finish it", or "what's left" about work from a
  session you cannot see.
- Your own context was summarized and the summary is too coarse for the decision
  in front of you.
- You are about to redo, revert, or build on something an earlier turn touched.

**Skip it** when the user's message contains the whole task, when `git log` and
the diff already answer the question, or when the branch is clean and new.

## The ladder — stop at the first rung that answers you

**0. Is there anything to read?** One command, and it exits non-zero (3) when the
lane has no repository or no state at all:

    octoview status

That prints the lane and one line per snapshot: number, the label the agent gave
it, how many files it touched, how many you have already reviewed, and which
agent made it. On a lane with a history this is usually enough to see the shape
of the work and which snapshots matter to you.

**1. Read the messages of the snapshots that matter — not all of them.** The
label is only the first line; the full message is the report that agent wrote
when it finished: the goal, the approach, the test numbers, what to look at.

A snapshot is a unit of work, not a session — one turn often left several, each
describing its own part. Read a run of them as one narrative rather than
assuming one per agent.

    octoview status --json | jq -r '.snapshots[] | select(.n >= 7) | "── \(.n) [\(.agent)]\n\(.message // .label)\n"'

Pick the range deliberately. The newest two or three usually carry the live
thread of work; older ones matter only when you are touching what they built.

**2. See what a snapshot actually changed.**

    octoview diff <n>              # its files, with review state
    octoview show <n> <path>       # that file as of that snapshot

**3. Read content only where it decides something.** Snapshot shas are ordinary
commits, so the net change across a run of them is `git diff <parent-of-first>
<sha-of-last>` using the shas from `status --json`.

## A message is testimony; the diff is evidence

The message says what an agent *believed* it had done as it finished. Between
then and now the human may have reverted a file, dropped a snapshot, or edited by
hand. Where the two disagree, the tree wins.

Three things the messages will not tell you, each worth one command when it
bears on your task:

- **What the human said back.** `octoview review batch --json` prints the latest
  submitted review — line comments, per file, with the snapshot each was opened
  against. If a batch exists and its points are not addressed in the tree, that
  is very likely your actual job.
- **What the human has already cleared.** `reviewed` on each file in
  `status --json`. Work already reviewed is not work to revisit.
- **What was thrown away.** A gap in the snapshot numbers is a dropped
  snapshot — work the human removed on purpose. Do not resurrect it without
  asking.

Also read `described` on a snapshot: `agent` means that agent wrote the message
itself and had therefore finished; `transcript` means the Stop hook scraped
whatever was last said, which is the shape an interrupted turn leaves behind. A
`transcript` message may describe work that was cut off half-done.

## What the lane does not carry

Snapshots are **per lane**, and a lane is the checked-out branch. Work done on
another branch is not in this lane's history, and a branch created after the work
started begins at snapshot 1 with nothing behind it. An empty history is
therefore not proof that nothing happened — check `git log` and the diff against
the base branch before concluding it.

## Leave the trail you wanted to find

The reason this record existed for you is that the agent before you closed its
turn properly. Do the same: `prepare-change-review` is the sibling skill, and its
closing message is what the next agent — or you, in a fresh session — will read
here.

## Never

- Never read or write `.git/octoview/` directly. The CLI owns that state and its
  locking.
- Never stage, commit, or revert to "clean up" what you found. Uncommitted work
  from an earlier turn is the human's to review; report what you found and ask.
