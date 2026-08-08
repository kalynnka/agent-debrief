# Playground

A scratch file for exercising the review loop end to end: leave a line comment,
submit the batch, hand it to the agent, watch the agent answer it.

## What a snapshot is

A snapshot is one agent turn, captured as a real git commit and referenced under
`refs/debrief/snapshots/<lane>/<n>`. The diff you read is snapshot N-1 -> N, so
you never re-read work you already cleared.

## What to try here

1. Open this file's diff for the newest snapshot. The right-hand side is the
   real file on disk, so the language server attaches while you read.
2. Comment on a line — any line, the wronger the better.
3. Comment on a line this snapshot deleted, too: the left side takes comments.
4. Submit the review. One batch, however many drafts went into it.
5. Send it to the terminal the agent is in, and let the agent answer.

## Claims worth arguing with

- Every snapshot needs a label, and the label is always a sentence.
- Two comments on the same line always merge into one thread.

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
