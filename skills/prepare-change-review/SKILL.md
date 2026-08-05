---
name: prepare-change-review
description: Prepare a finished agent turn for human review with octoview — make sure the turn is snapshotted, then assemble a change report from CLI facts, ordered the way the human reads a review. Use when a coding turn is complete and a human will review it.
---

# Prepare a change review

Octoview reviews work at the turn boundary, before anything is committed. Your
job at the end of a turn: make sure the turn is captured, then hand the human a
report whose facts come from the CLI, ordered for their reading.

## Rules that are not yours to bend

- **Never touch the user's git state.** No `git add`, no commits, no branch or
  stash operations. The staged set is the human's review progress marker; the
  tool exists to protect it. `octoview turn commit` is the one exception, and
  only on an instruction to commit in the human's *latest* message — see below.
- **Every git fact comes from the `octoview` CLI.** Never read or write
  `.git/octoview/` directly and never create or delete refs yourself — the CLI
  owns that state and its locking.
- **Do not mark anything reviewed, approved or waived.** Those actions belong to
  the human; the boundary is advisory and your side of it is to stay on it.

## Workflow

1. **Fix a turn that was recorded badly**, before anything else. A turn you were
   interrupted in was snapshotted by the hook with whatever you had last said —
   often a sentence from the middle of the work. Say it properly:

       octoview turn describe <n> -m "<kind>: <what that turn did>"

   Only the description moves. The snapshot, its ref and its place in the order
   are untouched, so anything already reviewed or committed against that turn is
   undisturbed.

2. **Collect the facts from the CLI, not from your memory of the work:**

       octoview status --json        # turns so far, files, review state
       octoview diff <n> --json      # exactly this turn's changed files
       octoview show <rev> <path>    # file content at a turn, for before/after

3. **Capture the turn with its message**, as the last thing you do before
   writing your reply — you cannot run a command after it:

       octoview turn snapshot --agent <host> --json -m "$(cat <<'EOF'
       <kind>: <what the turn did>

       <the paragraph>
       EOF
       )"

   Pass the front page only — the one-line summary and the paragraph. The
   per-file detail belongs in your reply, not in the note a review opens with.
   `--label` is unnecessary: the first line is the label.

   `"created": false` means the tree holds no new work — say so and stop. A turn
   that changed nothing is never recorded, by you or by the hook.

   **The hook is the backstop, not the author.** Where one is installed it fires
   after you and captures whatever you left uncaptured, reading the transcript
   for a message because it has nothing better. On a tree you have already
   snapshotted it takes no turn at all, and your message stands.

4. **Write the reply.** It opens with the same front page you just recorded, and
   the per-file detail follows it — see the next section.

5. **Stop.** The human reviews in their editor. Their comments come back to you
   as one batch: `octoview review batch --json`.

## The closing message is the review's front page

Octoview keeps the message a turn was recorded with — the one you pass to `-m`,
or, when the hook had to step in, the last thing you said. Its **first line
becomes that turn's row in the sidebar**, cut at 72 characters, and the **whole
message opens the review** as the first row of the multi-diff, above the files.
It is the only thing the human reads before the diff, so write it for that job.

Lead with these two, in this order, ahead of any per-file detail:

    <kind>: <what this turn did>        ← one line, ≤72 characters

    <one paragraph, four to six sentences>

`kind` is the set the commit subjects use — `feat`, `fix`, `docs`, `chore`,
`refactor`, `test`, `perf` — so the row says what sort of change it is before it
says anything else. The paragraph then says, in this order:

1. **The problem or goal.** What was wrong, or what was wanted — the condition
   itself, not a restatement of the request.
2. **How, in summary.** The approach, and the one or two decisions inside it a
   reviewer would otherwise have to reconstruct from the diff.
3. **Test status, in real numbers** — `37 checks pass (18 smoke + 19 cli)`, never
   "tests pass" — and a plain statement of what you did not run. A pre-existing
   failure is the first clause, not the last.
4. **What to look at.** Where the risk is, which file to read first, and any
   assumption you took that the human may want to reject.

Then the per-file detail, in the human's reading order: schema and data model
first, then managers and logic, then call sites and tests. For each file: what
changed, why, and anything you did not verify. Distinguish claims (yours) from
evidence (command output).

It is one turn's worth of change, so it is a pull request's description at a
tenth of the length. Aim for a paragraph a reviewer reads in fifteen seconds and
is then ready to read the diff.

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

## Landing a reviewed prefix

Only when the human asks for it in the message you are answering:

    octoview turn commit <n> -m "<subject>" --json

This commits turns 1..n as one commit and leaves every later turn uncommitted in
the working tree, which is what makes "commit through turn 10, keep going on
11+" possible: the content comes from turn n's snapshot, so the working tree
never moves and a file that turn 12 edited again still commits at its turn-10
value.

- `n` must be a turn that exists; the prefix is implied, so there is no way to
  commit a gapped set.
- It **replaces the index**, which is the human's review progress marker. The
  command refuses while anything is staged rather than discarding it.
- It refuses a turn **the hook recorded rather than you**. That is the shape a
  turn cut off mid-change leaves behind, and what lands is its snapshot exactly
  as it stands. Describing it (step 1) is the fix; `--force` is not.
- Do not reach for `--force` on their behalf — report either refusal and let
  them decide.
- `landed` in the JSON is the turns that now have nothing uncommitted left of
  them. It is derived from git, so it is also the answer after an amend, a reset
  or a rebase.

An instruction to commit is scoped to the turn it was given in, exactly like
every other approval. Having committed once grants nothing for the next batch.
