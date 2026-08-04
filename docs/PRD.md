# Octoview — Product Requirements

**Status:** draft · **Owner:** Lu Hui · **Last updated:** 2026-08-04

Turn-by-turn review of agent changes, in the editor where the language server
already runs.

**Positioning — the one sentence everything else serves:** Octoview is a
**pre-commit, pre-PR, human-in-the-loop review tool.** It reviews work that is
not committed yet, in the window between the agent finishing and me deciding, and
a human makes every decision in it. Anything that only works after a commit, only
works after a push, or decides on my behalf is out of scope by construction.

---

## 1. The problem

### 1.1 The headache

I review everything. During planning and during code changes, I leave a lot of
comments — and most of my repos have no CI, so my review is the only gate there
is. That makes review the bottleneck in every session I run with an agent, and
the tools I have make it worse in four specific ways.

**Batch commenting doesn't exist.** No agent surface in VS Code — Claude, Codex,
Copilot — lets me accumulate a set of comments and submit them as one reply. I
end up typing one thought at a time into a chat box, losing the shape of the
review, or writing the whole thing into a scratch file by hand.

**There is no review layer before the PR.** By the time a change reaches a GitHub
PR it is a squashed lump, and the moment to catch a wrong turn was twenty minutes
earlier. Copilot's per-turn change review is the right shape, and it's the one
thing in that product I actually want.

**I re-read what I already cleared.** Reviewing turn N against the branch base
means every file I read at turn 2 comes back at turn 3, unchanged, demanding to
be skimmed again. This is the single biggest waste in my current loop.

**Per-edit approval is worse than useless.** As agents get better, approving each
edit degrades into "approve all" — the same failure as auto mode, with more
clicking. The unit has to be big enough that reading it is a real decision.

### 1.2 Why a diff viewer is not enough

My [AGENTS.md](../../inky/AGENTS.md) is strict in ways a diff hunk cannot answer:
no `Any`, precise collection types, pyright-clean, helpers must have an owner.
"Does this call site still hold?" is a jump-to-definition question, and a Python
hunk routinely does not show the types of what it touches. **Language services
are load-bearing for my review, not a comfort.**

Language services attach to *real files*. Diff two virtual snapshots and neither
side gets Pylance. That single fact drives most of this design:

- Review happens **in the editor**, not in a web app — a web app would mean
  operating a language-server hosting platform as a side effect of wanting to
  read diffs.
- Review happens **at the turn boundary, against the working tree** — for the
  newest turn the right-hand side is the real file on disk, so hover, types and
  go-to-definition work while I read. Historical turns degrade to read-only by
  nature. Live review is the real mode; design for that.

### 1.3 The invariant everything else bends around

**The git index is mine.** I stage files as I finish reviewing them, so the
staged set is my progress marker. A tool that runs `git add`, moves `HEAD`, or
creates branches on my behalf destroys the thing the review exists to protect.
No feature is worth violating this.

---

## 2. Goals and non-goals

### Goals

- Make **the agent turn** the unit of review, with turn-over-turn diffs.
- Never re-present work I already cleared, and reopen it the moment it changes.
- Batch comments and deliver them back to the agent that wrote the code.
- Keep the language server attached while I read.
- Work with any coding agent in any VS Code-like IDE, and later outside it.
- Leave git — index, HEAD, branches, worktree — exactly as I left it.

### Non-goals

- **Not** a replacement for GitHub PR review. This sits *in front* of it.
- **Not** per-edit approve/reject. That is the failure mode, not the feature.
  Per-edit *provenance* — explaining a hunk without asking me to rule on it — is
  in scope, and §4.9 keeps the two apart.
- **Not** an agent runtime. Octoview never runs a model; it hands work to agents.
- **Not** an MCP server shipped inside the extension. An MCP→CLI adapter can be
  added later for a host that genuinely benefits, but the core never depends on
  MCP.
- **Not** a long-running daemon or local service, until something forces one.
- **Not** a second conversation model. Octomate already owns threads, runs and
  history; Octoview does not re-invent them.

---

## 3. Users and use cases

The user is one person reviewing their own agent's work, in their own repos,
with no CI. Everything below is written for that case first; team use arrives
only with Octomate sync (§5.6, M5).

### UC-1 — Review a turn while the agent keeps working (primary)

The agent finishes a turn. A snapshot is taken automatically. The Turns view
shows the changed files for that turn only. I open one, read it with Pylance
attached, leave three comments on specific lines, mark two other files reviewed,
and submit. The agent picks the batch up as its next input and continues.

### UC-2 — Interrupt mid-turn

Something looks wrong, or I want to stop and think. I interrupt the agent,
run **Snapshot Turn** manually, review what exists so far, then let the agent
continue. Manual snapshot is not a fallback for missing automation — it is a
first-class entry point for exactly this.

### UC-3 — Catch up after several turns

I stepped away and the agent ran four turns. Files I cleared at turn 2 and that
nobody touched since stay cleared. Files touched at turn 4 are open again. I read
the delta, not the branch.

### UC-4 — Consult the agent inline about its own change

Reading a hunk, I do not understand why a call site changed. From the comment
thread I ask the agent that wrote it — in its own session, with its own history —
and get an answer next to the code rather than in a chat panel scrolled away from
the diff.

### UC-5 — Review a GitHub PR with the same ritual

A PR arrives. I pull it into the same review surface, it appears as a single
turn, and I use the same diff view, the same comment batching, and the same
helper agent. Submitting posts the batch as a GitHub PR review.

### UC-6 — Review across several repos at once

The workspace holds four clones. A turn that touched two of them produces a turn
in each; the two it did not touch get nothing. Each repo keeps its own numbering
and its own state.

---

## 4. Review model

### 4.1 Turn

A **turn** is one agent turn, and the unit of review. Each turn is a real git
commit capturing the working tree at the moment the turn ended.

| Field | Meaning |
|---|---|
| `lane` | The line of work this turn belongs to (§4.2) |
| `n` | Per-lane sequence number |
| `sha` | Snapshot commit |
| `parent` | Previous turn's `sha`, or `HEAD` for turn 1 |
| `label` | What the turn did |
| `at` | Timestamp |
| `agent` | Which agent produced it (`claude`, `codex`, `copilot`, `manual`) |
| `session` | That agent's session id, when the host exposes one |
| `plan` | The lane's active plan revision at snapshot time (§4.7), if any |

`diff(parent, sha)` is exactly that turn's change. `agent` and `session` are what
make §7 possible — they are captured at snapshot time because that is the only
moment they are reliably known.

### 4.2 Lane — turns align with branches and worktrees

A **lane** is a line of work, identified by the checked-out branch. Turn
numbering, review state and comments are all per-lane.

This is not a concurrency feature bolted on; it is a correctness fix the POC
needs regardless:

- **Refs are shared across worktrees.** A linked worktree writes to the same
  `refs/` as its main tree, so `refs/octoview/turns/<n>` collides between two
  worktrees of one clone — verified, not assumed.
- **`.git` is a *file* in a linked worktree**, not a directory. The POC's
  `mkdir .git/octoview` fails with `ENOTDIR`, so both snapshotting and review
  state are broken in any worktree today.

Resolution:

| Concern | Rule |
|---|---|
| Lane id | Current branch. Detached HEAD falls back to the worktree name; a pulled PR is `pr/<number>` |
| Turn refs | `refs/octoview/turns/<lane>/<n>` |
| State | `<git-common-dir>/octoview/<lane>/state.json`, resolved via `git rev-parse --git-common-dir` so every worktree agrees |

Branch is the lane key rather than worktree path because git already forbids the
same branch in two worktrees, so branch → at most one worktree, and a branch
survives a worktree being thrown away. Switching branches mid-session starts a
new lane at turn 1, which is correct: the work changed.

**A lane ends the way its branch ends.** It closes when the branch is deleted, or
when the branch has been merged — `git merge-base --is-ancestor <branch>
<default>`, which is git's own answer rather than a status Octoview has to
maintain. A closed lane is eligible for cleanup (§4.8).

The default branch is the exception: `main` is trivially its own ancestor, so its
lane never auto-closes and is bounded by age and count alone. Long-lived work on
`main` is the normal case here, not an edge one.

**Concurrent agents** follow from this. Two agents working at once belong in two
worktrees on two branches, which is two lanes with independent numbering and no
interleaved attribution. Two agents in *one* worktree remain ambiguous — but that
is now a supported alternative rather than an unanswered question.

### 4.3 Snapshotting without touching git state

```
GIT_INDEX_FILE=<common>/octoview/<lane>/index  git read-tree <parent>
                                               git add -A
                                               git write-tree
                                               git commit-tree <tree> -p <parent>
                                               git update-ref refs/octoview/turns/<lane>/<n> <sha>
```

- The private index means the staged set I curate is never read or written.
- `refs/octoview/` is outside `refs/heads`, so `git branch` never lists a turn.
- **The `read-tree` seed is required, not an optimization.** Without it `add -A`
  starts from an empty index, where a file that is tracked *and* matched by
  `.gitignore` looks like a new ignored file — so it is skipped and every turn
  reports it deleted. This is not hypothetical: `kraken` pins `.python-version`
  that way, and the POC's first snapshot reported it deleted.
- A repo the turn did not change gets **no turn**. An empty turn would put a
  repo's numbering out of step with the work it describes.
- **Everything octoview records about a repo lives in that repo's own `.git`** —
  refs under `refs/octoview/`, state and batches under
  `<git-common-dir>/octoview/<lane>/`. The tool keeps no central store:
  reviewing four repos writes four repos' `.git` and nothing anywhere else,
  so a clone carries its own review history and deleting a clone deletes it.

### 4.4 Review state

`reviewed[file] >= turn` is the entire rule. Mark a file reviewed at turn 2, the
agent touches it at turn 4, it is unreviewed again. No bookkeeping, no matrix to
maintain, and it directly attacks UC-3.

Borrowed from Reviewable's per-file/per-revision model — **agent turns are
revisions** — with none of its product around it.

### 4.5 Comments

A thread anchors to `(file, line range, blob sha, content hash of the anchored
lines)`. Threads **carry forward** into later turns by locating the same content,
so a review conversation behaves the way a conversation should. If the anchored
lines themselves changed, the thread is marked **outdated** but stays visible and
open — GitHub's semantics, which I already have in my hands.

States: `draft → submitted → resolved`, with `outdated` as an orthogonal flag.

Threads batch as drafts and submit as one payload. That payload is the product's
actual output.

### 4.6 Evidence

The agent owns the explanation; **Octoview owns the evidence.** When an agent
claims "all tests pass", the claim is text; the CLI attaches the command, exit
code, output summary and the snapshot sha it ran against. A report carries both,
and they are distinguishable.

### 4.7 Artifacts — plans are reviewable too

The original motivation was commenting on **plans** as much as on code, and plan
review is where a wrong turn is cheapest to catch. A plan is therefore a
first-class reviewable artifact, not a chat message.

An artifact is text with revisions. It is stored as a **git blob**, kept alive by
a ref, and diffed with git:

```
git hash-object -w --stdin                                    # object store only
git update-ref refs/octoview/artifacts/<lane>/<slug> <blob>   # refs may point at blobs
git diff <blobA> <blobB>                                      # a real diff
```

Verified: `update-ref` accepts a blob, and `git diff` between two blobs produces
a normal unified diff. This writes nothing to the index, HEAD, a branch, or the
working tree — so §1.3 holds for plans exactly as it does for code.

Consequences that fall out for free:

- The **same** comment model applies. An anchor is `(container, line range,
  content hash)`; a container is a file path *or* an artifact slug. Carry-forward
  and outdated-marking (§4.5) work unchanged.
- A plan revision belongs to a turn, so "the agent revised the plan after my
  comments" is a turn like any other, and the plan's history sits beside the
  code's.
- Review of a plan produces the same batch, delivered by the same round-trip
  (§7), so plan review is not a second pipeline.

Artifacts are not limited to plans — a change report or a design note uses the
same path — but plans are the only one in scope.

**A lane has at most one active plan.** A branch is one piece of work, so it gets
one plan, and "which plan does this turn belong to?" stops being a question worth
modelling.

**A turn records the plan revision current when it was snapshotted** —
`plan: {slug, blob}` on the turn. The CLI reads it from the lane's active
artifact ref at snapshot time, so it costs nothing and depends on no agent
remembering to declare anything. That single field buys:

- which plan revision each turn was working from, in the turn list;
- "the plan was revised at turn 5", visible because turns 5+ cite a different
  blob;
- the plan diff across whatever range of turns I am reviewing.

**Drift is evidence, not a verdict.** The `verify-change-evidence` skill asks the
agent to explain how a turn follows the plan; the CLI supplies the facts —
the plan revision, the files each turn changed, and the changed paths the plan
text never mentions. That last one is a crude token match, and it is stated as
"the plan does not mention these paths", never as "the agent drifted". The agent
owns the explanation, Octoview owns the facts (§4.6), and a fuzzy signal is
honest as long as it is labelled as one.

Deliberately deferred: structured plan steps with stable ids and per-step
coverage. It gives real bidirectional drift detection — planned-but-unimplemented
as well as implemented-but-unplanned — but it forces a plan format and needs the
agent to keep a checklist honest. Not worth it until plan review has been used
enough to prove it is missed.

### 4.8 Retention and cleanup

Turn refs and snapshot objects accumulate, so cleanup is a product requirement,
not an afterthought.

`octoview gc` prunes, and a cheap prune check runs after each snapshot:

| Rule | |
|---|---|
| Closed lane — branch deleted, or merged into the default branch (§4.2) | Prune the whole lane |
| Turns older than the retention window (default 30 days) | Prune |
| Beyond the last *K* turns per lane (default 50) | Prune |

**Nothing with open review work is ever pruned** — a lane keeps any turn that has
an unresolved thread or a file still unreviewed, regardless of age or count. A
review that vanishes because a timer expired is worse than disk usage.

Pruning deletes the refs; git's own gc reclaims the objects. Octoview never runs
a destructive git command on the user's behalf beyond deleting refs it created.

### 4.9 Edit provenance inside a turn

A turn is the unit of *review*, but a turn's diff can still leave "why did this
line change?" unanswered — and until now this document had no answer at all. The
turn granularity is deliberate; the silence below it was not.

**Provenance, not approval.** §2 rejects per-edit approve/reject because it
degrades to "approve all". Provenance is the opposite kind of thing: it asks me
to decide nothing. It explains a hunk while I read the turn I was already going
to read. The distinction is written down here precisely because the two look
similar in a UI mock and must not drift together.

**Every tool call is already on disk.** Claude Code's transcript records each
`Edit` with `file_path`, `old_string`, `new_string`, `replace_all` and a stable
`tool_use` id, and each `Write` with full content — verified against a real
session, not assumed. Nothing needs capturing that is not already captured.

**Reconstruct at snapshot time; do not intercept.** A `PostToolUse` hook per edit
puts a process spawn on the hot path of every agent turn. The `Stop` hook that
already fires for the snapshot (§6) reads the transcript once and derives the
turn's edit list from it. Interception is the fallback if reconstruction ever
proves lossy, not the design.

**Read the transcript directly, never through Octomate.** The moment provenance
needs Octomate's database, the feature works only while Octomate is running and
tailing, and the extension stops being agent-agnostic — §5.3 undone by a feature.
The transcripts are plain files. The CLI reads them; Octomate reads the same
files for its own purposes. Two consumers of one source, neither depending on the
other.

**Scope: a per-file ordered edit list per turn**, each entry carrying the tool
call and the agent's surrounding text. Line-level attribution — replaying edits
over the base blob to colour individual lines — is deferred: it is real work, and
genuinely ambiguous once a later edit rewrites an earlier one. Add it only if its
absence is actually felt.

This is what no other tool does. VS Code, Zed, Cline and the third-party
hunk-review extensions all keep a *baseline copy* and recompute hunks against it,
so "per-edit" in their UIs means per-hunk of the accumulated diff, attributable
to nothing. Reading the transcript is what makes a hunk traceable to the decision
that produced it.

Two things fall out of the same read: the auto-snapshot label (§6), and the
evidence half of §4.6 — the tool call is the fact, the assistant's text around it
is the claim.

Host coverage follows §6's order: Claude first, Codex next. Copilot exposes no
comparable transcript, so its turns carry diffs without provenance.

---

## 5. Architecture

```
  skills / hooks / agents ──► octoview CLI ──┐
                                             ├──► review core ──► git + <repo>/.git/octoview
  Octoview UI (VS Code) ── in-process ───────┘
                                  │
                                  └── sync (M5) ──► Octomate API ──► Web UI
```

### 5.1 Review core (TypeScript)

Owns every invariant: private-index snapshotting, turn identity, base/head shas,
stale-review detection, comment anchoring and carry-forward, state transitions,
report and evidence schemas, locking.

It is a library of editor-free TypeScript modules (`lanes`, `git`, `state`,
`review`, `transcript`) in the octoview repo. The extension imports it
in-process; the `octoview` CLI is a thin bin over the same modules and is the
contract everything that is not the extension talks through. **One language for
core, CLI and extension** replaced the original Python-core plan (owner
decision, 2026-08-04): the POC's tested plumbing carried forward instead of
being rewritten, and the "same git logic in two languages" risk disappeared
outright.

### 5.2 CLI — the integration contract

The CLI is the stable public interface for every local surface. Rules for every
machine-facing command:

- `--json` with a versioned schema (`schemaVersion` in every payload)
- data on stdout, diagnostics on stderr
- stable exit codes
- explicit `--repo`
- structured input over stdin or a file
- idempotent where retries are plausible — `turn snapshot` with nothing changed
  creates no turn, exits 0, and reports `{"created": false}`

**v1 surface, deliberately small:**

| Command | Purpose |
|---|---|
| `octoview turn snapshot` | Capture a turn. `--label`, `--agent`, `--session`; `--from-stop-hook` reads Claude's Stop payload (session id, transcript path, project cwd) from stdin |
| `octoview status` | Lanes, turns, changed files, review state |
| `octoview diff <turn>` | Changed files for a turn |
| `octoview show <rev> <path>` | File content at a revision |
| `octoview plan put` / `plan show` | Write and read a plan artifact revision (§4.7) |
| `octoview review submit` | Emit the comment batch |
| `octoview review batch` | Read the latest batch (for agents) |
| `octoview gc` | Prune spent lanes and turns (§4.8) |

Every command takes `--repo` and `--lane`; both default to the current directory
and its checked-out branch. As of M1 all of these exist except `plan put/show`
(lands with M2's artifacts) and `gc`, which is designed (§4.8) but unbuilt.

Not in v1, each arriving with the milestone that needs it: `turn edits` (§4.9,
M2), `feedback list/reply` (M2), `evidence attach` (M2), `pr pull` (M4), `sync`
(M5), and `events --follow --jsonl` only if polling and file-watching prove
inadequate. A large surface with versioned schemas is a lot of contract for one
client; it grows when a milestone pulls on it, not in advance.

**`show` is on the v1 list on purpose.** If the extension keeps its own git
plumbing to render the diff's left-hand side, snapshot logic exists in two
languages — the exact failure this architecture is meant to prevent. The POC has
already produced two git-knowledge bugs (a rename-record parse error and a crash
on an unborn HEAD); neither should ever need fixing twice.

### 5.3 Distribution — where the decoupling actually lives

**The `octoview` CLI ships as its own installable and must not import
`octomate`.** This is the decision that determines whether the extension works
with Copilot or Cursor; the architecture diagram does not. If the CLI lands
inside the octomate package, the tool is re-coupled through the back door.

Repo layout: CLI and extension in the `octoview` repo (one pnpm package, the
CLI as its `bin`), released separately when release time comes. Dev install is
`pnpm link --global`, or an absolute `node <repo>/out/cli.js` path in hook
configs.

### 5.4 Extension — deliberately dumb

The extension renders core output and drives VS Code's Comments API, diff
editor, tree view and decorations. It holds no review policy, no snapshot
logic, and never parses human-oriented output.

With core and extension in one language the boundary is enforced by module
ownership rather than a process hop: the UI modules (`extension`, `turns`,
`comments`, `diff`) execute no git and hold no review state of their own —
git runs only inside the core's `git` module, and every mutation goes through
the same locked store the CLI uses. A second IDE client still needs only
process execution of the CLI plus JSON rendering.

All the VS Code APIs used are finalized and stable, with no Copilot involvement
and no model API. Octoview does not plug into VS Code's agent system: that would
mean adopting a second conversation model from a vendor whose product competes
with Octomate's.

### 5.5 Skills — workflow, not enforcement

Skills own judgment: when to snapshot, how to prepare a change report, how to
organize it in my review order (schema → managers → call sites), how to respond
to comments, what evidence to collect, what "ready for human review" means.

Planned: `prepare-change-review`, `address-review-feedback`, `independent-review`,
`verify-change-evidence`, `propose-review-guideline`.

**Skills invoke the CLI. Skills never write `.git/octoview/` directly.**

A skill is model-selected: the agent may forget it, decline to load it, or use it
wrong. So the CLI computes the git facts, validates payloads and refuses invalid
transitions; hooks capture turn boundaries deterministically; the skill supplies
rationale, risk and response.

Canonical workflow in the open Agent Skills format, delivered per host:

```
skills/prepare-change-review/SKILL.md      canonical, git-tracked in this repo
~/.claude/skills/prepare-change-review  →  symlink to the canonical dir: every
                                           Claude Code session in every repo,
                                           iterating live with this repo
.codex/…                                   Codex discovery (M3)
.github/agents/reviewer.agent.md           Copilot persona (M4)
```

A repo-local `.claude/skills/` wrapper was tried first and dropped (2026-08-04):
it only reached sessions opened in the octoview repo itself — exactly where the
skill is least needed. When delivery has to reach beyond this machine, the
packaged form is a Claude Code plugin: one install carrying the skill *and* the
Stop hook, replacing the per-repo `settings.local.json` wiring.

If logic starts accumulating in a wrapper, it belongs back in the skill or CLI.

### 5.6 Octomate — narrowed, and not in v1

The CLI owns local review execution. The Octomate API owns synchronization,
identity, collaboration, remote runs and shared history. Octomate already tails
Claude and Codex transcripts and tracks external runs with session identity, so
the sync layer joins on something that exists rather than inventing a new key.

---

## 6. Snapshot triggering

**Automatic is the target state; manual is permanent.**

**Automatic (preferred).** A stop-time hook fires when a turn ends and calls the
CLI. Claude Code's `Stop` hook and Codex's stop-time hooks both support this
without another protocol server anywhere. The hook passes `--agent` and
`--session`, which is what makes §7 work.

**Label without prompting.** A hook cannot ask me for a label. The CLI derives it
from the transcript the hook already points at — the agent's own last-turn
summary — falling back to `turn <n>`.

**Manual (UC-2).** `octoview turn snapshot`, and a VS Code command bound to it.
Required for the interrupt case, and the only path on hosts without hooks.

**Host order is Claude, then Codex, then Copilot.** The loop is proven end to end
on one agent before it is widened; a half-working round-trip on three hosts
teaches less than a complete one on a single host. Claude Code is first because
its `Stop` hook and `--resume` cover both §6 and §7 without a gap.

**Copilot custom agents** have no verified stop hook, and that verification is
postponed rather than blocking. Until it happens, Copilot turns are manual —
which UC-2 already makes a first-class path, so nothing is unusable meanwhile.

---

## 7. Agent integration

### 7.1 Feedback round-trip

Submitting a batch delivers it to the agent that wrote the turn, **preferring
that agent's own session** so it answers with its reasoning history intact:
`claude --resume <session>` and the Codex equivalent, keyed on the `agent` and
`session` recorded at snapshot time.

**When resume is unavailable** — Copilot today, or a manual snapshot with no
session recorded — Octoview starts a **fresh session with the same agent and
model**, seeded with the turn diff, the comment batch and the agent's last-turn
summary. History is lost; the agent is not.

### 7.2 Inline consult (UC-4)

From a comment thread, ask the authoring agent about that hunk, with the file,
the turn diff and the thread as context. Same preference order as §7.1. The
answer lands in the thread, next to the code.

### 7.3 Human-only actions — advisory, and honestly so

Approve, waive and mark-reviewed are mine. **This is not enforceable by a CLI:
the agent has the same shell I do and can run any command I can.** Skills
instruct agents not to call them, and the CLI records `--actor` so the action is
auditable after the fact.

Decision: **advisory only**, documented as such. Hook-based blocking is available
later if an agent actually self-approves, but shipping enforcement theatre that
only works on two of four hosts is worse than a stated limit.

---

## 8. GitHub PR review (UC-5)

`octoview pr pull <number>` fetches the PR into its own lane, `pr/<number>`, and
presents it as a **single turn**: `parent` = `merge-base(target, head)`, `sha` =
PR head. Everything downstream — diff view, review state, comment batching,
helper agent — is unchanged, and the lane keeps it clear of my own work.

**Real files, because §1.2 applies here too.** Default is a git worktree under
`.git/octoview/pr/<n>`: the language server attaches, my main tree and index are
untouched, and it is disposable. `--in-place` checks the PR out in the main tree
for people who prefer what the official GitHub extension does.

`octoview review submit --to github` posts the batch as a PR review through the
`gh` CLI, reusing its authentication rather than shipping a GitHub client.

**Future — shared turns.** If the PR author also uses Octoview, their turn
history could be published so a reviewer reads turn-by-turn instead of one
squashed diff. Transport is undecided: `refs/notes/octoview` is attractive
because notes anchor to commits and never touch the index, but it only works for
*committed* work. Deferred until the single-user loop is proven.

---

## 9. Milestones

| | Scope | Exit criteria |
|---|---|---|
| **M0** ✅ | POC extension: snapshot, turn tree, turn-over-turn diff, comments, batch submit, multi-repo | Done. 30 assertions across 9 headless check groups passing |
| **M1** ◐ | TypeScript core + CLI; lanes (§4.2), which also fixes worktrees; extension becomes a core client; Claude `Stop` hook auto-snapshot; `prepare-change-review` skill | Landed at `e80fae7` (2026-08-04), 109 assertions across 26 headless groups. Verified: UI modules hold zero git logic; two worktrees of one clone review independently. Still to demonstrate by hand: a full turn reviewed end to end in the editor, and a hook-driven turn appearing unprompted |
| **M2** | **Claude end to end**: feedback round-trip via `--resume`, inline consult, plan artifacts (§4.7) and plan-revision citation, edit provenance (§4.9) | UC-1 and UC-4 complete on Claude alone. A plan reviewed, revised, and implemented through the same batch. A hunk traceable to the tool call that wrote it |
| **M3** | Widen to Codex — stop hook, session resume — against the loop M2 proved | UC-1 and UC-4 on Codex with no core changes. Adding a host is configuration, not architecture |
| **M4** | PR import, GitHub submit; Copilot hook support verified | UC-5 end to end |
| **M5** | Octomate sync, read-only web view | A review readable outside the machine that produced it |

M2 finishing on a single agent is the point, not a compromise: it is what proves
adding the second host costs nothing structural.

---

## 10. Success criteria

1. **Zero mutations of my git state.** No change to index, HEAD, branches or
   worktree, ever. Asserted in tests, not asserted in prose.
2. Files cleared at turn N and untouched since never reappear.
3. A turn is reviewed and answered without leaving the editor.
4. Review comments reach the authoring agent with its history intact, on every
   host that supports resume.
5. Adding a second IDE client requires no review logic — only process execution,
   JSON rendering and editor APIs.

---

## 11. Risks

- **~~Two languages~~ — closed 2026-08-04.** Core, CLI and extension are all
  TypeScript now. What the risk was really about — the same git logic existing
  twice — is guarded instead by module ownership (git executes only in the
  core's `git` module) and by the headless suite.
- **Hook coverage is uneven.** Claude and Codex yes, Copilot unverified. Manual
  snapshot keeps every host usable; automation is a per-host upgrade.
- **Anchor drift.** Carry-forward matching will sometimes mis-locate. The
  outdated flag is the safety valve — a wrong anchor is visible, not silent.
- **Snapshot cost on large repos.** Seeding the private index each turn costs the
  stat cache a full re-hash. Correct but O(tree); measure before assuming it
  scales, and revisit only with numbers.
- **Advisory boundaries.** An agent can self-approve. Accepted, documented,
  auditable via `--actor`.
- **Overlap with VS Code's Agents Window — the largest open risk.** VS Code
  Preview now ships range-anchored feedback comments batched behind a *Submit
  Feedback* action, *Mark as Reviewed*, and a reviewed state that "clears" when a
  later agent turn changes the file — the same rule as §4.4. That covers a
  meaningful part of UC-1, UC-3 and UC-4 natively.

  What it does **not** cover, and what Octoview's value now rests on:

  - **Durability.** VS Code's snapshots are per-request and explicitly temporary,
    designed to "complement Git but not replace it". Octoview's turns are git
    commits, reviewable days later and after a restart.
  - **The index invariant.** Staging in the Source Control view *auto-accepts*
    pending edits, and discarding discards them — VS Code's edit state is coupled
    to the staging area I use as my review progress marker (§1.3).
  - **Agent reach.** The feature works "for agents that run through an agent host
    provider". Whether locally-run Claude Code and Codex qualify is unverified
    and is the single fact that most changes this product's value.
  - **Reach beyond one editor** — CLI, JetBrains, PR review, cross-repo, plans.

  This must be settled by a hands-on check before M1 starts, not argued from
  documentation.

---

## 12. Open questions

Resolved: concurrent agents → lanes keyed to branches and worktrees (§4.2); lane
lifecycle → closes when its branch is deleted or merged (§4.2); plan review →
plans are git-blob artifacts sharing the comment model (§4.7); plan-to-code
linkage → the turn cites the plan revision, drift is evidence rather than a
verdict (§4.7); retention → `octoview gc`, never pruning open review work (§4.8);
host order → Claude end to end first, Copilot postponed (§6); implementation
language → TypeScript end to end (§5.1, 2026-08-04); concurrent writers → an
advisory lock file around every read-modify-write, one implementation covering
every writer including the hook, exercised by two real spawned processes in the
test suite (2026-08-04); how the UI learns a turn happened → a debounced file
watch on the lane's state directory, no daemon (2026-08-04); the two POC bugs →
fixed in M1's git layer with regression tests (rename records parsed as the
three fields they carry; an unborn HEAD snapshots against the empty tree).

Still open:

1. **Label quality from the transcript.** §6 derives a turn's label from the
   agent's last-turn summary. Whether that reads well enough to navigate by is an
   empirical question, answerable only once M1 produces real turns.
2. **Snapshot cost at scale.** Seeding the private index each turn re-hashes the
   tree. Fine on a 284-file repo; unmeasured on a large one. Needs numbers before
   it needs a solution.

---

## Appendix — POC findings that shaped this document

| Finding | Consequence |
|---|---|
| Language services attach only to real files | Editor-first, not web-first; review at the turn boundary |
| Reviewable's file×revision state | `reviewed[file] >= turn` |
| Per-edit approval degrades to "approve all" | Turn is the unit |
| Claude transcripts already carry every `Edit` with `old_string`/`new_string` and a stable `tool_use` id | Edit provenance needs no new capture, and no Octomate dependency (§4.9) |
| VS Code, Zed, Cline and hunk-review extensions all diff against a *baseline copy* | Their "per-edit" is per-hunk, attributable to nothing; transcript-derived provenance is unoccupied ground |
| Tracked-but-ignored files vanish from a virgin index | `read-tree` seed is mandatory |
| Refs are shared across a clone's worktrees | Turn refs must be lane-scoped |
| `.git` is a file in a linked worktree — `mkdir .git/octoview` gives `ENOTDIR` | State lives under `--git-common-dir`; worktrees are broken in the POC |
| `update-ref` accepts a blob, and `git diff` works between two blobs | Plans can be pure git objects, touching nothing |
| `--name-status -z` rename records have three fields | Parser bug; fixed in M1, regression-tested |
| `commit-tree -p` fails on an unborn HEAD | A fresh `git init` repo cannot be snapshotted; fixed in M1 via the empty-tree base, regression-tested |
| Cline, Cursor and Zed all do checkpoints; none do comments | Comments differentiate against *those* tools |
| VS Code's Agents Window (Preview, 1.120+) ships batched feedback comments, mark-as-reviewed, and reviewed-state reset on a later agent turn | **Comments alone are no longer the differentiator** — see §11 |
