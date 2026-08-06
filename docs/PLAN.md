# Octoview — Landing Plan

**Status:** M1 landed at `733bc0b` · **Covers:** M0 → M1 · **Last updated:** 2026-08-04

Companion to [PRD.md](PRD.md). The PRD says what to build and why; this says in
what order it lands, and how each landing is verified.

**After landing (2026-08-04):** the owner switched implementation to TypeScript
end to end — one language with the extension, pnpm as the package manager — so
the Python-specific details below became TypeScript ones. The step order was
followed as written; each step carries a **Landed** note saying what shipped
and where reality deviated. The biggest deviation is Step 5: with one language
nothing was deleted — the POC modules were reworked *into* the core. The §2
gate was consciously deferred by the owner; it now governs M2 re-scoping
rather than M1's start.

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

**Lands:** a CLI that resolves where it is and prints valid JSON.

```
octoview/
  src/lanes.ts     # repo + lane resolution (core)
  src/cli.ts       # bin entry, envelope, exit codes
  test/cli.js      # lane resolution + CLI contract
```

- The envelope every command returns: `schemaVersion`, payload on stdout,
  diagnostics on stderr, documented exit codes.
- `--repo` and `--lane` resolution: git root, `--git-common-dir`, current branch,
  detached-HEAD fallback to worktree name.
- One command, `octoview status`, reporting repo, lane and an empty snapshot list.

**Why first, given the model-before-interface rule:** the envelope *is* a schema.
Every later step conforms to it, and changing it afterwards means rewriting every
command and the extension at once.

**Verified:** envelope shape; lane resolution in a main tree, a linked worktree,
and on a detached HEAD. **Not verified:** nothing yet reads real snapshots.

**Size:** small.

**Landed:** as written (in TS, after a false start in Python the owner redirected).
An unborn-HEAD lane resolves too — octoview's own pre-first-commit state forced it.

---

## 4. Step 2 — Git layer, lanes, and the two known bugs

**Lands:** all snapshot plumbing in Python, lane-scoped, with the POC's bugs dead.

- Private index at `<common>/octoview/<lane>/index`, seeded with `read-tree`.
- Refs at `refs/octoview/snapshots/<lane>/<n>`.
- `changed_files` parsing `--name-status -z` correctly — **rename records carry
  three fields**, which the POC reads as pairs and silently truncates.
- **Unborn HEAD** handled: snapshot 1 in a fresh `git init` repo commits with no
  parent and diffs against the empty-tree hash.
- `file_at`, `drop_turn_ref`.

**Verified by test, all headless:**

| | |
|---|---|
| Index, HEAD and branch list unchanged after N snapshots | the §1.3 invariant, asserted not asserted-in-prose |
| A tracked-but-gitignored file survives | the `read-tree` regression |
| Snapshot works inside a linked worktree | `.git`-is-a-file, currently `ENOTDIR` |
| Two worktrees keep independent snapshot numbering | shared-refs collision |
| A rename record yields one entry with both paths | POC bug |
| A repo with no commits can be snapshotted | POC bug |
| Snapshot 2 does not re-show snapshot 1's files | snapshot-over-snapshot isolation |

**Size:** medium, and the densest step. If it reads long, the split is
lanes-and-paths first, then snapshot-and-diff.

**Landed:** reworked `src/git.ts` in place (plumbing verbs only — policy moved
to `src/review.ts`). Every row of the table above is a passing check in
`test/smoke.js` or `test/cli.js`.

---

## 5. Step 3 — Store, review state, and the locking decision

**Lands:** persistence, and the answer to PRD §12.1.

- `state.json` per lane under the common dir.
- `reviewed[file] >= snapshot`.
- `snapshot`, `diff`, `show`, `status` now fully functional from the CLI.

**Recommendation for the concurrency question:** an advisory lock file around
every read-modify-write, and nothing more. All writes already funnel through the
CLI (§5.4), so one lock implementation covers every writer including the hook.
Splitting snapshots from review state into separate files also helps, but it is a
second mechanism for a problem the lock already solves — take it only if
contention shows up in practice.

**Verified:** two CLI processes writing concurrently lose no updates (spawned for
real, not simulated); state round-trips; reviewed state resets on a later snapshot.

**Size:** medium.

**Landed:** as recommended — `Store.withLock` in `src/state.ts` wraps every
read-modify-write including the whole snapshot (which also serializes the shared
private index). Two racing captures produce exactly one snapshot, asserted with two
real processes.

---

## 6. Step 4 — Comments, anchoring, batch

**Lands:** the review conversation.

- Anchor: `(container, line range, blob sha, content hash)`, where container is a
  file path or an artifact slug (§4.7 keeps the second case cheap).
- Carry-forward into later snapshots by content; **outdated** when the anchored lines
  themselves changed.
- `review submit` and `review batch`.

**Verified:** a thread follows its code into a later snapshot; a thread goes outdated
when its lines change; a batch round-trips through disk.

**Size:** medium-to-large — **the most likely step to need splitting.** The split
is (a) anchor model and carry-forward, (b) submit and batch. Anchoring is where
the fuzzy matching lives and deserves to be read on its own.

**Landed:** anchors in `src/state.ts`, carry-forward and `makeAnchor` in
`src/review.ts` — a thread also follows a rename to its new path. Matching is
exact-block, nearest occurrence to the old position; anything less than exact
goes `outdated` rather than guessed.

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
- **Existing POC state is discarded, not migrated.** Two snapshots in `inky`, two in
  `kraken`, one of them carrying the phantom-deletion bug. Migration code would
  outlive its purpose by years.

**Verified:** the headless suite still passes for what remains. **Not verified,
and this is the real gap:** tree rendering, comment widgets, diff display and the
Pylance-on-the-right-hand-side claim all need the Extension Development Host and
a human. Step 5 is where hands-on checking is mandatory, not optional.

**Size:** medium, weighted toward deletion.

**Landed differently:** nothing was deleted — with one language the POC modules
*became* the core, and "the extension becomes a client" means the UI modules
(`extension`, `snapshots`, `comments`, `diff`) execute no git and mutate state only
through the locked store. The CLI-finding decision dissolved (same package); the
no-migration decision stood: POC state in inky and kraken is simply ignored by
the lane-scoped scheme. The editor-host gap above remains real and open.

---

## 8. Step 6 — Auto-snapshot, and how the UI finds out

**Lands:** UC-1's "a snapshot is taken automatically".

- A Claude Code `Stop` hook calling
  `octoview snapshot --agent claude --session <id>`.
- Label derived from the transcript the hook already points at.
- The extension notices.

**Recommendation for PRD §12.2:** the extension watches the lane's `state.json`.
It is a file watch, not a service, so the no-daemon non-goal holds; `events
--follow` stays unbuilt until a client exists that a file watch cannot serve.

**Verified:** a real Claude turn in `kraken` produces a snapshot that appears in the
view without pressing Refresh. This one cannot be tested headlessly and must be
demonstrated.

**Size:** small in code, and the first moment the product feels like itself.

**Landed:** `--from-stop-hook` on `snapshot` (payload from stdin, label
from the transcript's last assistant text, `snapshot <n>` fallback); the watch is a
debounced `fs.watch` on each lane's state dir, as recommended. Hook installed
for kraken via `.claude/settings.local.json` (kept out of `git status` by
`.git/info/exclude`) and for inky the same way. The headless suite covers the
hook path with a synthetic transcript; **the live unprompted-appearance demo is
still owed.**

---

## 9. Step 7 — The `prepare-change-review` skill

**Lands:** `skills/prepare-change-review/SKILL.md` canonical, plus a thin
`.claude/` wrapper.

**Verified:** the agent runs the workflow, calls the CLI for every fact, and
writes nothing under `.git/octoview/` directly. The last clause is the one worth
checking deliberately, because it is the boundary §5.5 rests on.

**Size:** small.

**Landed:** `skills/prepare-change-review/SKILL.md` canonical; delivery is a
`~/.claude/skills` symlink to it — the in-repo `.claude/skills/` wrapper was
dropped because it only reached octoview's own sessions (PRD §5.5). The
verified-clause above is behavioral and gets its check the first time an agent
actually runs the workflow.

---

## 10. M1 is done when

1. ✅ The extension contains no git logic of its own — with one language the
   criterion became: git executes only in the core's `git` module, never in the
   UI modules.
2. ⏳ A full turn is reviewed end to end without invoking the CLI by hand —
   needs the editor host and a human.
3. ✅ Two worktrees of one clone are reviewed independently, with separate
   numbering — asserted by test.
4. ✅ Snapshotting still leaves index, HEAD and branches untouched — asserted by
   test, staged file included.
5. ⏳ A Claude turn snapshots itself and appears in the view unprompted — hook
   path tested headlessly; the live demonstration is still owed.

---

## 11. Risks specific to landing

- **~~Step 5 is the irreversible one~~** — dissolved by the single-language
  decision: nothing was removed, the POC was reworked in place, and the whole of
  M1 landed as one reviewable tree at `733bc0b`.
- **Editor-host testing stays manual.** Nothing in this plan fixes that. It is
  survivable at this size and would be the first thing to reconsider if the
  extension grows.
- **~~Two languages, briefly duplicated~~** — closed outright on 2026-08-04:
  core, CLI and extension are all TypeScript.
- **Scope creep from M2.** Plans, provenance and the round-trip are all designed
  and tempting. None of them land in M1.

---

## 12. Not in this plan

M2 onward — feedback round-trip, inline consult, plan artifacts, edit provenance,
Codex, PR import, Octomate sync. They get their own plan once M1 has been used
for real work, because M1's usage is what should reorder them.
