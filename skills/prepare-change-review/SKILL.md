---
name: prepare-change-review
description: Prepare a finished agent turn for human review with octoview — make sure the turn is snapshotted, then assemble a change report from CLI facts, ordered the way the human reads a review. Use when a coding turn is complete and a human will review it.
---

# Prepare a change review

Octoview reviews work at the turn boundary, before anything is committed. Each
turn's work is captured as a **snapshot** — a real git commit outside
`refs/heads`. Your job at the end of a turn: make sure the snapshot is taken,
then hand the human a report whose facts come from the CLI, ordered for their
reading.

To read snapshots somebody else left behind rather than write one, the sibling
skill `recover-change-context` is the one you want.

## Rules that are not yours to bend

- **Never touch the user's git state.** No `git add`, no commits, no branch or
  stash operations. The staged set is the human's review progress marker; the
  tool exists to protect it. `octoview snapshot commit` is the one exception, and
  only on an instruction to commit in the human's *latest* message — see below.
- **Every git fact comes from the `octoview` CLI.** Never read or write
  `.git/octoview/` directly and never create or delete refs yourself — the CLI
  owns that state and its locking.
- **Do not mark anything reviewed, approved or waived.** Those actions belong to
  the human; the boundary is advisory and your side of it is to stay on it.

## Workflow

1. **Fix a snapshot that was recorded badly**, before anything else. A turn you
   were interrupted in was snapshotted by the hook with whatever you had last
   said — often a sentence from the middle of the work. Say it properly:

       octoview snapshot describe <n> -m "<kind>: <what that snapshot did>"

   Only the description moves. The snapshot, its ref and its place in the order
   are untouched, so anything already reviewed or committed against it is
   undisturbed.

2. **Collect the facts from the CLI, not from your memory of the work:**

       octoview status --json        # snapshots so far, files, review state
       octoview diff <n> --json      # exactly this snapshot's changed files
       octoview show <rev> <path>    # file content at a snapshot, for before/after

3. **Take the snapshot with its message**, as the last thing you do before
   writing your reply — you cannot run a command after it:

       octoview snapshot --agent <host> --json -m "$(cat <<'EOF'
       <kind>: <what the turn did>

       <the few lines under it>
       EOF
       )"

   Pass a summary, not the report: a subject line and at most four short lines
   under it. The reasoning and the per-file detail belong in your reply, not in
   the note a review opens with. `--label` is unnecessary: the first line is the
   label.

   `"created": false` means the tree holds no new work — say so and stop. A
   snapshot that changed nothing is never recorded, by you or by the hook.

   **The hook is the backstop, not the author.** Where one is installed it fires
   after you and captures whatever you left uncaptured, reading the transcript
   for a message because it has nothing better. On a tree you have already
   snapshotted it takes nothing at all, and your message stands.

4. **Write the reply.** It opens with the same summary you just recorded, and the
   per-file detail follows it — see the next section.

5. **Stop.** The human reviews in their editor. Their comments come back to you
   as one batch: `octoview review batch --json`.

## A turn is not one snapshot

Nothing limits a turn to one. A snapshot costs a commit object and a ref, and it
is the unit the human reads, reverts and commits — so it should hold **one unit
of work**, not one session of it. Whenever a piece of the work is finished and
would stand on its own in a review, snapshot it and say what it did, then start
the next piece.

    …schema and migration done…      octoview snapshot -m "feat(schema): …"
    …managers updated…               octoview snapshot -m "feat(managers): …"
    …call sites and tests…           octoview snapshot -m "test: …"   ← closes the turn

The human gets what they would otherwise have to ask for: a change landed in the
order they read it, each part revertable on its own, and a commit prefix that can
stop at the part they have actually cleared.

Two rules make it worth doing rather than noise:

- **Each message describes its own snapshot**, not the turn so far. The reader
  sees them as separate rows and reverts them separately.
- **The last one still closes the turn**, taken as the final act before you
  reply, so nothing is left for the hook to catch. Work done *after* a snapshot
  is uncaptured until something captures it — and when that something is the
  Stop hook, it lands with whatever sentence you happened to end on. That is
  what a `described: "transcript"` snapshot is, and step 1 is the way back.

## When no snapshot is taken

`octoview snapshot` reports `created: false` for two different reasons, and only
one of them is routine.

`nothing changed` is the normal one — an idle turn, or work you already
snapshotted. Nothing to do.

`<operation> is in progress` means git is part-way through a merge, rebase,
cherry-pick, revert or bisect. The working tree holds conflict markers or
half-applied commits, which are nobody's work yet, so nothing is recorded. Do not
work around it. Say so, finish or abort the operation, and the next snapshot picks
everything up.

One more thing worth saying in your message when it applies: if HEAD moved while
you worked — you pulled, merged, or the human committed — the review will mark
those files `⇣ not the agent's`. Do not claim them. Octoview works that out from
the recorded HEAD, but a sentence naming what arrived saves the reviewer the
guess.

## The closing message is the review's front page

Octoview keeps the message a snapshot was recorded with — the one you pass to
`-m`, or, when the hook had to step in, the last thing you said. Its **first line
becomes that snapshot's row in the sidebar**, cut at 72 characters, and the
**whole message opens the review** as the first row of the multi-diff, above the
files. It is the only thing the human reads before the diff, so write it for that
job.

**It is a summary, and short is the whole of the job.** It is read in the two
seconds between opening a review and reading the diff, so anything the reader has
to wade through has already failed — and the diff below it is where the detail
actually lives. A subject line and at most four short lines under it:

    <kind>: <what this snapshot did>    ← one line, ≤72 characters

    Why: the condition that wanted fixing, in a sentence.
    How: the approach, and any decision the diff will not show on its own.
    Tests: real numbers — 45 checks pass (24 smoke + 21 cli) — then what you
      did not run.
    Look at: the file to read first, and the assumption they may reject.

`kind` is the set the commit subjects use — `feat`, `fix`, `docs`, `chore`,
`refactor`, `test`, `perf` — so the row says what sort of change it is before it
says anything else.

Every line but the first is optional, and a line with nothing to say is left out
rather than filled in. Two that carry something beat four that pad. A line that
has run to three sentences is a paragraph wearing a label, and belongs in your
reply instead.

**Nothing renders it.** The review shows the message in a diff row, which draws
no markdown at all — every `**`, every `[label](path)`, every `##` arrives as
literal characters in the reader's face. Write plain text: name a file as
`src/cli.ts:220`, not as a link, and let a blank line do the work bold would
have done. The sidebar hover does render markdown, so anything that reads well
both ways — a `-` list, a backticked identifier — is fine; anything that only
works rendered is not.

**The per-file detail goes in your reply, never here.** There it sits beside the
rest of your answer and can be as long as the change deserves, in the human's
reading order: schema and data model first, then managers and logic, then call
sites and tests. For each file: what changed, why, and anything you did not
verify. Distinguish claims (yours) from evidence (command output).

The note is also what the *next* agent on this branch will read to work out what
happened here, long after this session is gone — see `recover-change-context`.
That is an argument for writing it for a reader with none of your context, not
for writing more: what that reader needs is the same five lines, and the diff is
still right there underneath them.

### What ruins it

- **A first line that reports the build instead of the change.** "Done. `tsc`
  clean, 36 checks pass" is a true sentence and a useless label — twenty rows of
  it in the sidebar say nothing about any of them. Name the change.
- **A first line that narrates.** "Now the manifest —" is a preamble to a tool
  call, and it is exactly what gets captured when it is the last thing you said.
  Close the turn with the report, not with a step of it.
- **Detail with no statement in front of it.** A wall of per-file notes leaves
  the reviewer to derive the goal from the diff, which is the work the message
  exists to save.
- **Length.** Paragraphs where a line would do, the reasoning behind the
  approach, the alternatives you rejected, a file-by-file account — all of it is
  worth saying and none of it belongs in the row above the diff. A note the
  reader has to scroll is one they skip, and then the four lines that mattered
  went unread too.
- **Markup nobody renders.** `Read [cli.ts:220](src/cli.ts#L220) first` is read
  exactly like that, brackets and all, by the one reader it was written for. The
  reply you type in chat is rendered; this is not. Keep them in different
  registers.

## Landing a reviewed prefix

Only when the human asks for it in the message you are answering:

    octoview snapshot commit <n> -m "<subject>" --json

This commits snapshots 1..n as one commit and leaves every later snapshot
uncommitted in the working tree, which is what makes "commit through snapshot 10,
keep going on 11+" possible: the content comes from snapshot n, so the working
tree never moves and a file that snapshot 12 edited again still commits at its
snapshot-10 value.

- `n` must be a snapshot that exists; the prefix is implied, so there is no way
  to commit a gapped set.
- It **replaces the index**, which is the human's review progress marker. The
  command refuses while anything is staged rather than discarding it.
- It refuses a snapshot **the hook recorded rather than you**. That is the shape
  a turn cut off mid-change leaves behind, and what lands is that snapshot
  exactly as it stands. Describing it (step 1) is the fix; `--force` is not.
- Do not reach for `--force` on their behalf — report either refusal and let
  them decide.
- `landed` in the JSON is the snapshots that now have nothing uncommitted left of
  them. It is derived from git, so it is also the answer after an amend, a reset
  or a rebase.

An instruction to commit is scoped to the turn it was given in, exactly like
every other approval. Having committed once grants nothing for the next batch.
