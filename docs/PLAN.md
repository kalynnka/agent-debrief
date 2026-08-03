# Octoview — Landing Plan

**Status:** draft · **Covers:** M0 → M1 · **Last updated:** 2026-08-04

Companion to [PRD.md](PRD.md). The PRD says what to build and why; this says in
what order it lands, and how each landing is verified.

---

## 1. What "landing" means here

There is no CI. Review is the only gate, so the plan is shaped around the review
rather than around the code:

- **Every step leaves a working tree.** The POC extension keeps working, unchanged,
  until Step 5 replaces it. There is never a window with no usable tool.
- **Every step is one sitting's reading.** Where a step is likely to exceed that,
  it says so and names the split rather than delivering it whole.
- **Within a step, order is schema → model → managers → interface → call sites.**
- **Nothing is staged or committed without asking, per step.**
- **Every step names what was verified and what was not.** The POC's honest gap —
  anything needing the editor host is unexercised by tests — persists, and the
  plan says where.

---

## 2. Step 0 — Decision gate (no code)

**§11 of the PRD says this must be settled before M1 starts, and it means it.**

Open the Agents Window in VS Code 1.131 against `kraken`, drive a turn with
Claude Code, and answer one question: does a locally-run Claude Code session
appear as an "agent host provider" with the Changes panel and *Add Feedback*
available?

| Answer | Consequence |
|---|---|
| **No** — local Claude is not an agent host | The PRD stands. Proceed to Step 1 unchanged |
| **Yes**, and it covers UC-1/3/4 well | Re-scope before writing code. What survives is durability, the index invariant, PR review, cross-repo and plans — a smaller, still-real product, but M1 and M2 need rewriting first |

Cost: under an hour. Everything downstream is cheaper than getting this wrong.

---

## 3. Step 1 — CLI skeleton and the JSON contract

**Lands:** a Python package that resolves where it is and prints valid JSON.

```
octoview/
  cli/
    pyproject.toml
    src/octoview/{__init__,lanes,cli}.py
    tests/
  src/  test/  docs/          # extension, untouched
```

- The envelope every command returns: `schemaVersion`, payload on stdout,
  diagnostics on stderr, documented exit codes.
- `--repo` and `--lane` resolution: git root, `--git-common-dir`, current branch,
  detached-HEAD fallback to worktree name.
- One command, `octoview status`, reporting repo, lane and an empty turn list.

**Why first, given the model-before-interface rule:** the envelope *is* a schema.
Every later step conforms to it, and changing it afterwards means rewriting every
command and the extension at once.

**Verified:** envelope shape; lane resolution in a main tree, a linked worktree,
and on a detached HEAD. **Not verified:** nothing yet reads real turns.

**Size:** small.

---

## 4. Step 2 — Git layer, lanes, and the two known bugs

**Lands:** all snapshot plumbing in Python, lane-scoped, with the POC's bugs dead.

- Private index at `<common>/octoview/<lane>/index`, seeded with `read-tree`.
- Refs at `refs/octoview/turns/<lane>/<n>`.
- `changed_files` parsing `--name-status -z` correctly — **rename records carry
  three fields**, which the POC reads as pairs and silently truncates.
- **Unborn HEAD** handled: turn 1 in a fresh `git init` repo commits with no
  parent and diffs against the empty-tree hash.
- `file_at`, `drop_turn_ref`.

**Verified by test, all headless:**

| | |
|---|---|
| Index, HEAD and branch list unchanged after N snapshots | the §1.3 invariant, asserted not asserted-in-prose |
| A tracked-but-gitignored file survives | the `read-tree` regression |
| Snapshot works inside a linked worktree | `.git`-is-a-file, currently `ENOTDIR` |
| Two worktrees keep independent turn numbering | shared-refs collision |
| A rename record yields one entry with both paths | POC bug |
| A repo with no commits can be snapshotted | POC bug |
| Turn 2 does not re-show turn 1's files | turn-over-turn isolation |

**Size:** medium, and the densest step. If it reads long, the split is
lanes-and-paths first, then snapshot-and-diff.

---

## 5. Step 3 — Store, review state, and the locking decision

**Lands:** persistence, and the answer to PRD §12.1.

- `state.json` per lane under the common dir.
- `reviewed[file] >= turn`.
- `turn snapshot`, `diff`, `show`, `status` now fully functional from the CLI.

**Recommendation for the concurrency question:** an advisory lock file around
every read-modify-write, and nothing more. All writes already funnel through the
CLI (§5.4), so one lock implementation covers every writer including the hook.
Splitting turns from review state into separate files also helps, but it is a
second mechanism for a problem the lock already solves — take it only if
contention shows up in practice.

**Verified:** two CLI processes writing concurrently lose no updates (spawned for
real, not simulated); state round-trips; reviewed state resets on a later turn.

**Size:** medium.

---

## 6. Step 4 — Comments, anchoring, batch

**Lands:** the review conversation.

- Anchor: `(container, line range, blob sha, content hash)`, where container is a
  file path or an artifact slug (§4.7 keeps the second case cheap).
- Carry-forward into later turns by content; **outdated** when the anchored lines
  themselves changed.
- `review submit` and `review batch`.

**Verified:** a thread follows its code into a later turn; a thread goes outdated
when its lines change; a batch round-trips through disk.

**Size:** medium-to-large — **the most likely step to need splitting.** The split
is (a) anchor model and carry-forward, (b) submit and batch. Anchoring is where
the fuzzy matching lives and deserves to be read on its own.

---

## 7. Step 5 — The extension becomes a client

**Lands:** deletion. `src/git.ts` and `src/state.ts` go; `src/cli.ts` replaces
them with process execution, JSON parsing and a schema-version check. The tree,
diff and comment surfaces render CLI output. The revision content provider calls
`octoview show`.

This is the step that makes §5.4 true rather than aspirational, and it should
read as mostly-removal.

**Two decisions inside it:**

- **Finding the CLI.** An `octoview.cliPath` setting, else `octoview` on `PATH`.
  Dev install is `uv tool install --editable ./cli`.
- **Existing POC state is discarded, not migrated.** Two turns in `inky`, two in
  `kraken`, one of them carrying the phantom-deletion bug. Migration code would
  outlive its purpose by years.

**Verified:** the headless suite still passes for what remains. **Not verified,
and this is the real gap:** tree rendering, comment widgets, diff display and the
Pylance-on-the-right-hand-side claim all need the Extension Development Host and
a human. Step 5 is where hands-on checking is mandatory, not optional.

**Size:** medium, weighted toward deletion.

---

## 8. Step 6 — Auto-snapshot, and how the UI finds out

**Lands:** UC-1's "a snapshot is taken automatically".

- A Claude Code `Stop` hook calling
  `octoview turn snapshot --agent claude --session <id>`.
- Label derived from the transcript the hook already points at.
- The extension notices.

**Recommendation for PRD §12.2:** the extension watches the lane's `state.json`.
It is a file watch, not a service, so the no-daemon non-goal holds; `events
--follow` stays unbuilt until a client exists that a file watch cannot serve.

**Verified:** a real Claude turn in `kraken` produces a turn that appears in the
view without pressing Refresh. This one cannot be tested headlessly and must be
demonstrated.

**Size:** small in code, and the first moment the product feels like itself.

---

## 9. Step 7 — The `prepare-change-review` skill

**Lands:** `skills/prepare-change-review/SKILL.md` canonical, plus a thin
`.claude/` wrapper.

**Verified:** the agent runs the workflow, calls the CLI for every fact, and
writes nothing under `.git/octoview/` directly. The last clause is the one worth
checking deliberately, because it is the boundary §5.5 rests on.

**Size:** small.

---

## 10. M1 is done when

1. The extension contains no git logic — `grep` for `execFile.*git` in `src/`
   returns nothing.
2. A full turn is reviewed end to end without invoking the CLI by hand.
3. Two worktrees of one clone are reviewed independently, with separate numbering.
4. Snapshotting still leaves index, HEAD and branches untouched, asserted by test.
5. A Claude turn snapshots itself and appears in the view unprompted.

---

## 11. Risks specific to landing

- **Step 5 is the irreversible one.** Everything before it is additive and the POC
  keeps working; Step 5 removes the TypeScript implementation. It should not land
  until Steps 1–4 are reviewed and the CLI has been driven by hand against
  `kraken`.
- **Editor-host testing stays manual.** Nothing in this plan fixes that. It is
  survivable at this size and would be the first thing to reconsider if the
  extension grows.
- **Two languages, briefly duplicated.** Between Steps 2 and 5 the same git logic
  exists in Python and TypeScript. That window is intentional and bounded; it
  must not be extended by adding features to the TypeScript side during it.
- **Scope creep from M2.** Plans, provenance and the round-trip are all designed
  and tempting. None of them land in M1.

---

## 12. Not in this plan

M2 onward — feedback round-trip, inline consult, plan artifacts, edit provenance,
Codex, PR import, Octomate sync. They get their own plan once M1 has been used
for real work, because M1's usage is what should reorder them.
