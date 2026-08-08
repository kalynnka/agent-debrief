# Playground

A scratch file for exercising the review loop end to end: leave a line comment,
submit the batch, hand it to the agent, watch the agent answer it.

Round two. What is being tested this time is where a comment says it came from:
comment on **this** snapshot's diff and on an older one, and every thread should
name the snapshot whose diff you were reading.

## What a snapshot is

A snapshot is one agent turn, captured as a real git commit and referenced under
`refs/debrief/snapshots/<lane>/<n>`. The diff you read is snapshot N-1 -> N, so
you never re-read work you already cleared.

## What to try here

1. Open this file's diff for the newest snapshot and comment on a line.
2. Open snapshot 1's diff — an older one — and comment there too.
3. Comment on a line **this** snapshot deleted, on the left-hand side. That one
   is the whole point: the text is the previous snapshot's, but the diff you are
   reading is this one, and this one is what the thread should say.

## Claims worth arguing with

- Every snapshot needs a label, and the label is always a sentence.

## Where the review lands

A submitted batch is written to `.git/debrief/<lane>/batches/<timestamp>.json`
inside the repository that was reviewed. It stays out of `git status` because
`.git/` is not the working tree, so no `.gitignore` entry is ever needed.

The agent reads it back with `debrief review open`, which prints every comment
still waiting across every batch — not just the last one submitted.

## Three ways to hand it over

| way | what it does | when it fits |
|---|---|---|
| Copy Review | puts the text on the clipboard | the agent is somewhere else |
| Send to Terminal | pastes it into the agent's terminal | the agent is running here |
| `review open` | the agent asks for it itself | the agent is picking work up |

Sending to the terminal wraps the text in a bracketed paste, so a terminal UI
reads the whole review as one insertion rather than as typing.

## Known rough edges

- A resolved thread disappears from `review open` with no way to see it again.
- Nothing stops two reviewers submitting batches a second apart.
- One thread is drawn once per document, so the Comments panel lists it once for
  every revision you have opened. Still unfixed — the next thing on the list.

## What each thread should say

| where you comment | the thread should say |
|---|---|
| the newest snapshot's diff | the newest snapshot |
| snapshot 1's right-hand side | snapshot 1 |
| snapshot 2's left-hand side | snapshot 2, not snapshot 1 |
| the file on disk | the newest snapshot |

If a thread names the newest snapshot when you were reading an older diff, the
fix is not live — reload the Extension Development Host and try again.
