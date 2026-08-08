---
name: prepare-change-review
description: Prepare a finished agent turn for human review with debrief — make sure the turn is snapshotted, then assemble a change report from CLI facts, ordered the way the human reads a review. Use when a coding turn is complete and a human will review it.
---

# Prepare a change review

Debrief reviews work at the turn boundary, before anything is committed. Each
turn's work is captured as a **snapshot** — a real git commit outside
`refs/heads`. Your job at the end of a turn: make sure the snapshot is taken,
then hand the human a report whose facts come from the CLI, ordered for their
reading.

To read snapshots somebody else left behind rather than write one, the sibling
skill `recover-change-context` is the one you want.

## Rules that are not yours to bend

- **Never touch the user's git state.** No `git add`, no commits, no branch or
  stash operations. The staged set is the human's review progress marker; the
  tool exists to protect it. `debrief snapshot commit` is the one exception, and
  only on an instruction to commit in the human's *latest* message — see below.
- **Every git fact comes from the `debrief` CLI.** Never read or write
  `.git/debrief/` directly and never create or delete refs yourself — the CLI
  owns that state and its locking.
- **Do not approve or waive anything.** Those judgements belong to the human; the
  boundary is advisory and your side of it is to stay on it.

## Workflow

1. **Fix a snapshot that was recorded badly**, before anything else. A turn you
   were interrupted in was snapshotted by the hook with whatever you had last
   said — often a sentence from the middle of the work. Say it properly:

       debrief snapshot describe <n> \
         --label "<kind>: <one sentence saying what that snapshot did>" \
         -m "<the two or three lines under it>"

   Only the description moves. The snapshot, its ref and its place in the order
   are untouched, so anything already reviewed or committed against it is
   undisturbed.

2. **Collect the facts from the CLI, not from your memory of the work:**

       debrief status --json        # snapshots so far, files, review state
       debrief diff <n> --json      # exactly this snapshot's changed files
       debrief show <rev> <path>    # file content at a snapshot, for before/after

3. **Take the snapshot with its label and message**, as the last thing you do
   before writing your reply — you cannot run a command after it:

       debrief snapshot --agent <host> --json \
         --label "<kind>: <one sentence saying what this snapshot did>" \
         -m "$(cat <<'EOF'
       <two or three short lines>
       EOF
       )"

   Both are needed, and neither is the other cut in half — the next section is
   what each one is for. The reasoning and the per-file detail belong in your
   reply, never in the note a review opens with.

   `"created": false` means the tree holds no new work — say so and stop. A
   snapshot that changed nothing is never recorded, by you or by the hook.

   **The hook is the backstop, not the author.** Where one is installed it fires
   after you and captures whatever you left uncaptured, reading the transcript
   for a message because it has nothing better. On a tree you have already
   snapshotted it takes nothing at all, and your message stands.

4. **Write the reply.** It opens with the same sentence you used as the label,
   and everything you left out of the note goes here — see the next section.

5. **Stop.** The human reviews in their editor. Their comments come back to you
   as one batch — see *Picking the review up* below.

## A turn is not one snapshot

Nothing limits a turn to one. A snapshot costs a commit object and a ref, and it
is the unit the human reads, reverts and commits — so it should hold **one unit
of work**, not one session of it. Whenever a piece of the work is finished and
would stand on its own in a review, snapshot it and say what it did, then start
the next piece.

    …schema and migration done…      debrief snapshot --label "feat(schema): …" -m …
    …managers updated…               debrief snapshot --label "feat(managers): …" -m …
    …call sites and tests…           debrief snapshot --label "test: …" -m …  ← closes the turn

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

`debrief snapshot` reports `created: false` for two different reasons, and only
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
those files `⇣ not the agent's`. Do not claim them. Debrief works that out from
the recorded HEAD, but a sentence naming what arrived saves the reviewer the
guess.

## A label, and three lines under it

A snapshot carries two things a human reads, and they are **separate fields**,
not one text cut in half.

**`--label` is one sentence saying what this snapshot did.** It is the row in the
sidebar, and often the only thing anybody reads. Write it; do not let it be
sliced off something else. `<kind>: ` in front, from the set the commit subjects
use — `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf` — then the
sentence, and the whole thing inside 72 characters:

    feat: a review opens without the files you have already read

**`-m` is at most three short sections**, shown above the diff when the review
opens. The label already said what changed and the diff is about to show how, so
these are only the things neither of them can say. Each gets its own line, with a
**blank line between them** — the note is read in one glance, and three lines
stacked without air is one paragraph wearing three labels:

    Purpose: a re-read review reopened every file, and the cleared ones were noise.

    Verification: 47 checks pass; the two buttons are unclicked.

    Risks: the tick is a proposed API and goes with any VS Code update — src/extension.ts:52
    is where it is worked around.

**Most snapshots have no Risks line, and that is the normal case.** Leave it out.
It is for a real one — something that could be wrong, something you did not
verify, an assumption the reviewer may want to reject — and for nothing else.
Writing it to reassure ("nothing else is load-bearing"), or to describe the change
again in different words, is the failure this section keeps walking into: a line
that appears on every snapshot stops being read on any of them. When there is one,
it is about the whole snapshot rather than one file; naming a file is how you
point at it, not what the section is for.

Purpose and Verification are the two that usually earn their place. One is fine.
**Under 300 characters all told** is the target — a note the reader has to scroll
is one they skip, and then the line that mattered went unread with it.

**One short sentence per section, and Verification is the one that tempts you
otherwise.** The counts, what each suite covers, what you could not check, what
to re-run — all of that is your reply's job. Here it is `47 checks pass`, and a
second clause only when something did *not*: `47 pass; the buttons are unclicked`.
A reader who wants the rest has your reply open beside the diff.

**A `path:line` reference becomes a clickable link.** Write it plainly —
`src/extension.ts:52`, or `src/review.ts:270-275` for a span — and debrief
underlines it in the note and in the sidebar hover, jumping to the file on disk.
This is the reason to write plain text rather than markdown: a markdown link
arrives with its brackets showing, and a plain reference reads correctly
everywhere *and* clicks.

Both are required together: `debrief snapshot -m …` without `--label` is a usage
error, because a label taken off the front of a message is how rows end up
reading like the middle of a turn.

    debrief snapshot --agent <host> --json \
      --label "<kind>: <one sentence>" \
      -m "$(cat <<'EOF'
      Purpose: …

      Verification: …
      EOF
      )"

**Nothing renders it.** The review shows the message in a diff row, which draws
no markdown at all — every `**`, every `[label](path)`, every `##` arrives as
literal characters in the reader's face. Write plain text. The sidebar hover does
render markdown, so anything that reads well both ways is fine; anything that
only works rendered is not.

**Everything else goes in your reply.** The approach, the alternatives you
rejected, the per-file account in the human's reading order, what you did not
verify and why — all of it is worth saying, and none of it belongs in the three
lines above a diff. Your reply is rendered, sits beside the rest of the
conversation, and can be as long as the change deserves. The note cannot.

The note is also what the *next* agent on this branch will read, long after this
session is gone — see `recover-change-context`. That is a reason to write the
label for someone with none of your context, not a reason to write more: the diff
is right there underneath it.

### What ruins it

- **A label that reports the build instead of the change.** "Done. `tsc` clean,
  36 checks pass" is a true sentence and a useless row — twenty of them say
  nothing about any of them. Name the change.
- **A label that narrates.** "Now the manifest —" is a preamble to a tool call,
  and it is exactly what the hook captures when it is the last thing you said.
  Close the turn with the report, not with a step of it.
- **A message that repeats the label.** They are shown together. Saying it twice
  costs the reader the one line that was going to tell them something new.
- **Length.** Paragraphs where a line would do. If a line has run to three
  sentences it is a paragraph wearing a label, and it belongs in your reply.
- **A section filled in because it is in the template.** A Risks line on a change
  with no risk is noise on every snapshot that has one, because the reader stops
  believing the label. Two real sections beat three with a passenger.
- **Markup nobody renders.** `Read [cli.ts:220](src/cli.ts#L220) first` is read
  exactly like that, brackets and all, by the one reader it was written for —
  and it costs the link the plain reference would have got for free.

## Picking the review up

The human's comments never interrupt you. They pile up while the human reads and
arrive all at once because you are the one who asks — a comment is waiting from
the moment it is written, and nothing tells you until you look. So the first thing
to do when they mention a review, or say they have finished reading, or send a
message with comments pasted into it, is to ask what is actually waiting:

    debrief review open           # every comment still waiting on you
    debrief review open --json    # the same, with anchors, ids and state

Each one carries `path:line`, the snapshot it was written against, and an id.
`outdated` on a comment means the lines it was written against have changed since
— it still stands, but find what it is about rather than trusting the line
number.

Work through them, then close what you have dealt with:

    debrief review resolve <id> <id> …

**Closing is not bookkeeping, it is the state.** `review open` is the only thing
that says what is left, so a comment you answered but did not resolve comes back
on every read, and one you resolved without answering is gone with nobody
noticing. Resolve exactly what you have done, and say in your reply what you did
for each id.

Leave a comment open when you are disagreeing with it. Say why, do not resolve
it, and let the human close the argument — resolving your way out of a
disagreement is the one use of this command that is a lie.

Then snapshot the work the review produced, exactly as any other turn: it is its
own unit of work and the human will read it as one.

`debrief review batch --json` still exists and answers a different question —
the contents of one submit, as a record. `review open` is the one to work from.

## Landing a reviewed prefix

Only when the human asks for it in the message you are answering:

    debrief snapshot commit <n> -m "<subject>" --json

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
