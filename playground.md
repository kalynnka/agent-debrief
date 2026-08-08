# Playground

A scratch file for exercising the review loop end to end: leave a line comment,
submit the batch, hand it to the agent, watch the agent answer it.

Round three, and it has one job: **the left-hand side**. Every comment so far has
been on a line that still exists, which is the easy half.

## What a snapshot is

A snapshot is one agent turn, captured as a real git commit and referenced under
`refs/debrief/snapshots/<lane>/<n>`. The diff you read is snapshot N-1 -> N, so
you never re-read work you already cleared.

## What to try here

1. Open the newest snapshot's diff. Every line struck through in red is one this
   snapshot deleted — comment on one of those.
2. Comment on a surviving line in the same diff, so there is something to compare
   it against.
3. Leave the tabs open, then message the agent.

## Where the review lands

A submitted batch is written to `.git/debrief/<lane>/batches/<timestamp>.json`
inside the repository that was reviewed. It stays out of `git status` because
`.git/` is not the working tree, so no `.gitignore` entry is ever needed.

The agent reads it back with `debrief review open`, which prints every comment
still waiting across every batch — not just the last one submitted.

## Known rough edges

- A resolved thread disappears from `review open` with no way to see it again.
- Nothing stops two reviewers submitting batches a second apart.
- `Notes.md` takes comments, and anchors them to a file that does not exist.

## The answer key

A comment on a **deleted** line is the case none of this has been tested on. Four
things should be true of it, and each one is a different piece of machinery:

| what | should be |
|---|---|
| the snapshot it names | the one that deleted the line, not the one that still had it |
| where it sits in that diff | on the deleted line, unmoved, for good |
| `outdated` | true — a line that is gone cannot be found again |
| the Comments panel | one row, and one only |
| the file on disk | nothing — a line that is gone has no place there |

A comment on a surviving line in the same diff should name the same snapshot, be
`outdated: false`, and live on the file instead. That is the control, and the two
together are the whole rule: a thread is drawn wherever its lines still are.

One row means one, with a single exception — the tab you typed into keeps its
widget until you close it.
