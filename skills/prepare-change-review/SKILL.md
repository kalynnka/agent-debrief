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
  tool exists to protect it.
- **Every git fact comes from the `octoview` CLI.** Never read or write
  `.git/octoview/` directly and never create or delete refs yourself — the CLI
  owns that state and its locking.
- **Do not mark anything reviewed, approved or waived.** Those actions belong to
  the human; the boundary is advisory and your side of it is to stay on it.

## Workflow

1. **Capture the turn** — skip this when a Stop hook already snapshots the repo:

       octoview turn snapshot --label "<one line: what the turn did>" --agent <host> --json

   `"created": false` means the tree holds no new work: say so and stop.

2. **Collect the facts from the CLI, not from your memory of the work:**

       octoview status --json        # turns so far, files, review state
       octoview diff <n> --json      # exactly this turn's changed files
       octoview show <rev> <path>    # file content at a turn, for before/after

3. **Write the report in the human's reading order**: schema and data model
   first, then managers and logic, then call sites and tests. For each file:
   what changed, why, and anything you did not verify. Distinguish claims
   (yours) from evidence (command output).

4. **Verification gets real numbers** — `52 assertions, 17 groups, all passing`,
   never "tests pass" — and a plain statement of what was not run. A
   pre-existing failure is the headline, not background noise.

5. **Stop.** The human reviews in their editor. Their comments come back to you
   as one batch: `octoview review batch --json`.
